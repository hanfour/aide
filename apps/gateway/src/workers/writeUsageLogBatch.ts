/**
 * Shared transactional writer for usage log batches (Plan 4A Part 7).
 *
 * Used by:
 *   - `usageLogWorker.ts` (#flush) for the normal batched-worker path.
 *   - `usageLogQueue.ts`  (`enqueueUsageLog` fallback) for the inline write
 *     when BullMQ enqueue fails (Task 7.3) so the row still lands in
 *     usage_logs even with Redis down.
 *
 * Both paths must produce IDENTICAL SQL — extracting it here keeps the two
 * call sites in lockstep and avoids drift when columns change.
 *
 * What this does, in one transaction:
 *   1. One multi-row INSERT into usage_logs.
 *   2. One UPDATE per distinct api_key_id, summing the batch's totalCost
 *      against `api_keys.quota_used_usd` and bumping last_used_at /
 *      updated_at.
 *
 * Notes:
 *   - The INSERT does NOT use onConflictDoNothing on request_id.  If a
 *     downstream retry (BullMQ ACK lost after commit, OR the inline
 *     fallback running after a worker also picked up the same row) hits
 *     UNIQUE(request_id) the entire txn aborts.  This is intentional for
 *     now — duplicate writes corrupt quota_used_usd, so erroring is safer.
 *     The caller (worker / fallback) decides how to react.
 *   - Cost decimals are summed in Postgres via parameterised
 *     `+ <value>::numeric` fragments, never via JS Number arithmetic, to
 *     keep `decimal(20,10)` precision intact.
 */

import { eq, sql, type SQL } from "drizzle-orm";
import { apiKeys, usageLogs } from "@aide/db";
import type { Database } from "@aide/db";
import type { UsageLogJobPayload } from "./usageLogQueue.js";

/**
 * Insert `payloads` into usage_logs and bump api_keys.quota_used_usd in a
 * single Drizzle transaction.  Throws on any DB error (caller decides retry
 * vs log-and-drop).  Empty `payloads` is a no-op.
 */
export async function writeUsageLogBatch(
  db: Database,
  payloads: UsageLogJobPayload[],
): Promise<void> {
  if (payloads.length === 0) return;

  await db.transaction(async (tx) => {
    // 1. Multi-row INSERT into usage_logs.
    // NOTE: no .onConflictDoNothing() on request_id — if BullMQ misses the
    // ACK after commit, retry hits UNIQUE(request_id) and the entire retry
    // batch fails.  Same caveat applies to the inline-fallback path: a
    // duplicate write would double-charge quota_used_usd, so we let the
    // UNIQUE constraint reject rather than silently accept.
    await tx.insert(usageLogs).values(
      payloads.map((p) => ({
        requestId: p.requestId,
        userId: p.userId,
        apiKeyId: p.apiKeyId,
        accountId: p.accountId,
        orgId: p.orgId,
        teamId: p.teamId,
        requestedModel: p.requestedModel,
        upstreamModel: p.upstreamModel,
        platform: p.platform,
        surface: p.surface,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        cacheCreationTokens: p.cacheCreationTokens,
        cacheReadTokens: p.cacheReadTokens,
        inputCost: p.inputCost,
        outputCost: p.outputCost,
        cacheCreationCost: p.cacheCreationCost,
        cacheReadCost: p.cacheReadCost,
        totalCost: p.totalCost,
        rateMultiplier: p.rateMultiplier,
        accountRateMultiplier: p.accountRateMultiplier,
        stream: p.stream,
        statusCode: p.statusCode,
        durationMs: p.durationMs,
        firstTokenMs: p.firstTokenMs,
        bufferReleasedAtMs: p.bufferReleasedAtMs,
        upstreamRetries: p.upstreamRetries,
        failedAccountIds: p.failedAccountIds,
        userAgent: p.userAgent,
        ipAddress: p.ipAddress,
      })),
    );

    // 2. One UPDATE per distinct api_key_id with the SUMmed totalCost.
    const grouped = groupTotalCostByApiKey(payloads);
    for (const [apiKeyId, totals] of grouped.entries()) {
      const sumExpr = buildNumericSumExpr(totals);
      await tx
        .update(apiKeys)
        .set({
          quotaUsedUsd: sql`${apiKeys.quotaUsedUsd} + ${sumExpr}`,
          lastUsedAt: sql`NOW()`,
          updatedAt: sql`NOW()`,
        })
        .where(eq(apiKeys.id, apiKeyId));
    }
  });
}

// ── Internal helpers (exported for unit testing) ─────────────────────────────

/**
 * Group payloads by `apiKeyId`, returning a Map of api_key_id → list of
 * `totalCost` strings to add.  Map iteration order is insertion order, so
 * the resulting UPDATEs are deterministic per batch.
 */
export function groupTotalCostByApiKey(
  payloads: UsageLogJobPayload[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of payloads) {
    out.set(p.apiKeyId, [...(out.get(p.apiKeyId) ?? []), p.totalCost]);
  }
  return out;
}

/**
 * Build an `sql` fragment of the form `(v1 + v2 + ... + vN)::numeric` where
 * each vᵢ is parameterised. Decimal sums computed in Postgres preserve full
 * `decimal(20,8)` precision; doing the sum in JS via Number addition loses
 * precision past ~15 significant digits.
 *
 * Single-element batches collapse to `(v1)::numeric`, which Postgres folds.
 */
export function buildNumericSumExpr(values: string[]): SQL<unknown> {
  if (values.length === 0) {
    // Defensive — shouldn't happen because groupTotalCostByApiKey only
    // produces non-empty arrays — but a 0::numeric add is a safe no-op.
    return sql`0::numeric`;
  }
  // Build the expression incrementally so each value is its own parameter.
  // sql.join would let us interpose ' + ' but using reduce keeps the
  // parameters explicit and easy to audit.
  let acc = sql`${values[0]}::numeric`;
  for (let i = 1; i < values.length; i++) {
    acc = sql`${acc} + ${values[i]}::numeric`;
  }
  return sql`(${acc})`;
}

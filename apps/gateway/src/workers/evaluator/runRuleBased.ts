/**
 * Rule-based evaluator worker logic (Plan 4B Part 4, Task 4.2).
 *
 * Pure-ish function that fetches usage logs and request bodies for a given
 * user/period, decrypts body blobs, scores them via the rule engine, and
 * upserts the resulting report into `evaluation_reports`.
 */

import { sql, and, eq, gte, lt, inArray } from "drizzle-orm";
import type { Database } from "@aide/db";
import { usageLogs, requestBodies, evaluationReports } from "@aide/db";
import { decryptBody } from "../../capture/encrypt.js";
import {
  scoreWithRules,
  type Rubric,
  type UsageRow,
  type BodyRow,
} from "@aide/evaluator";
import type { DataQuality } from "@aide/evaluator";

// ── Input / Output types ─────────────────────────────────────────────────────

export interface RunRuleBasedInput {
  db: Database;
  masterKeyHex: string;
  orgId: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
  periodType: "daily" | "weekly" | "monthly";
  rubric: Rubric;
  rubricId: string;
  rubricVersion: string;
  triggeredBy: "cron" | "admin_rerun" | "manual";
  triggeredByUser: string | null;
}

export interface RunRuleBasedResult {
  /** null if the window was empty (skipped=true). */
  reportId: string | null;
  totalScore: number;
  dataQuality: DataQuality;
  /** true when the evaluation window contained no usage rows. */
  skipped: boolean;
}

// ── Main function ────────────────────────────────────────────────────────────

export async function runRuleBased(
  input: RunRuleBasedInput,
): Promise<RunRuleBasedResult> {
  const { db, masterKeyHex, orgId, userId, periodStart, periodEnd } = input;

  // 1. Fetch usage_logs in window
  const usageRowsRaw = await db
    .select()
    .from(usageLogs)
    .where(
      and(
        eq(usageLogs.userId, userId),
        gte(usageLogs.createdAt, periodStart),
        lt(usageLogs.createdAt, periodEnd),
      ),
    );

  if (usageRowsRaw.length === 0) {
    return {
      reportId: null,
      totalScore: 0,
      dataQuality: {
        capturedRequests: 0,
        missingBodies: 0,
        truncatedBodies: 0,
        totalRequests: 0,
        coverageRatio: 0,
      },
      skipped: true,
    };
  }

  const requestIds = usageRowsRaw.map((r) => r.requestId);

  // 2. Fetch request_bodies for those request IDs
  const bodyRowsRaw =
    requestIds.length === 0
      ? []
      : await db
          .select()
          .from(requestBodies)
          .where(inArray(requestBodies.requestId, requestIds));

  // 3. Decrypt body blobs — failures treated as empty body (graceful degradation)
  const bodyRows: BodyRow[] = bodyRowsRaw.map((b) => {
    const requestBodyStr = safeDecrypt(
      masterKeyHex,
      b.requestId,
      b.requestBodySealed,
    );
    const responseBodyStr = safeDecrypt(
      masterKeyHex,
      b.requestId,
      b.responseBodySealed,
    );

    return {
      requestId: b.requestId,
      stopReason: b.stopReason ?? null,
      clientUserAgent: b.clientUserAgent ?? null,
      clientSessionId: b.clientSessionId ?? null,
      requestParams: b.requestParams ?? null,
      responseBody: tryParse(responseBodyStr),
      requestBody: tryParse(requestBodyStr),
    };
  });

  // 4. Normalize usage rows to the shape scoreWithRules expects
  const usageRows: UsageRow[] = usageRowsRaw.map((u) => ({
    requestId: u.requestId,
    requestedModel: u.requestedModel,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    totalCost: u.totalCost,
  }));

  const truncatedRequestIds = new Set(
    bodyRowsRaw
      .filter((b) => b.bodyTruncated)
      .map((b) => b.requestId),
  );

  // 5. Score with rules
  const report = scoreWithRules({
    rubric: input.rubric,
    usageRows,
    bodyRows,
    truncatedRequestIds,
  });

  // 6. Upsert into evaluation_reports (unique on userId + periodStart + periodType)
  const inserted = await db
    .insert(evaluationReports)
    .values({
      orgId,
      userId,
      teamId: null,
      periodStart,
      periodEnd,
      periodType: input.periodType,
      rubricId: input.rubricId,
      rubricVersion: input.rubricVersion,
      totalScore: String(report.totalScore),
      // jsonb columns — cast to unknown to satisfy Drizzle's strict typing
      sectionScores: report.sectionScores as unknown,
      signalsSummary: report.signalsSummary as unknown,
      dataQuality: report.dataQuality as unknown,
      triggeredBy: input.triggeredBy,
      triggeredByUser: input.triggeredByUser,
    })
    .onConflictDoUpdate({
      target: [
        evaluationReports.userId,
        evaluationReports.periodStart,
        evaluationReports.periodType,
      ],
      set: {
        totalScore: String(report.totalScore),
        sectionScores: report.sectionScores as unknown,
        signalsSummary: report.signalsSummary as unknown,
        dataQuality: report.dataQuality as unknown,
        rubricVersion: input.rubricVersion,
        rubricId: input.rubricId,
        triggeredBy: input.triggeredBy,
        triggeredByUser: input.triggeredByUser,
        updatedAt: new Date(),
      },
    })
    .returning({ id: evaluationReports.id });

  return {
    reportId: inserted[0]?.id ?? null,
    totalScore: report.totalScore,
    dataQuality: report.dataQuality,
    skipped: false,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decrypt a sealed body blob. Returns empty string on any failure so a single
 * corrupted blob does not fail the entire evaluation report.
 */
function safeDecrypt(
  masterKeyHex: string,
  requestId: string,
  sealed: Buffer,
): string {
  try {
    return decryptBody({ masterKeyHex, requestId, sealed });
  } catch {
    return "";
  }
}

/**
 * Try to parse a string as JSON. Returns the raw string on failure so callers
 * always get a usable value.
 */
function tryParse(s: string): unknown {
  if (s === "") return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

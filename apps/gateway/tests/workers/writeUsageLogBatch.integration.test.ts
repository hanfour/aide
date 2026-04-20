/**
 * Integration test for the shared `writeUsageLogBatch` helper (Plan 4A
 * Part 7, Task 7.3).
 *
 * The worker integration test (`usageLogWorker.integration.test.ts`)
 * already exercises this code path via the BullMQ batcher.  The cases here
 * pin the helper as a STANDALONE callable, because Task 7.3's inline
 * fallback in `enqueueUsageLog` calls it directly (no worker, no Redis).
 *
 * Coverage:
 *   - single-payload write commits with the correct row + quota update
 *   - duplicate request_id raises (matches the documented retry caveat —
 *     no onConflictDoNothing, so a UNIQUE collision aborts the txn)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { eq, sql } from "drizzle-orm";
import {
  apiKeys,
  organizations,
  upstreamAccounts,
  usageLogs,
  users,
  type Database,
} from "@aide/db";
import type { UsageLogJobPayload } from "../../src/workers/usageLogQueue.js";
import { writeUsageLogBatch } from "../../src/workers/writeUsageLogBatch.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@aide/db/package.json")),
  "drizzle",
);

// ── Container + shared fixtures ──────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

let orgId: string;
let userId: string;
let accountId: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({
      slug: "write-usage-log-batch-test-org",
      name: "writeUsageLogBatch Test Org",
    })
    .returning();
  orgId = org!.id;

  const [user] = await db
    .insert(users)
    .values({ email: "write-usage-log-batch-test@example.com" })
    .returning();
  userId = user!.id;

  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "test-upstream-wulb",
      platform: "anthropic",
      type: "oauth",
    })
    .returning();
  accountId = acct!.id;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

// ── Per-test cleanup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE usage_logs RESTART IDENTITY CASCADE`);
  await db.execute(sql`TRUNCATE TABLE api_keys CASCADE`);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedApiKey(prefix: string): Promise<{ id: string }> {
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId,
      orgId,
      keyHash: `hash-${prefix}-${Math.random().toString(36).slice(2)}`,
      keyPrefix: prefix,
      name: `key-${prefix}`,
      quotaUsd: "100.00000000",
      quotaUsedUsd: "0",
    })
    .returning({ id: apiKeys.id });
  return row!;
}

function makePayload(
  apiKeyId: string,
  totalCost: string,
  requestId: string,
): UsageLogJobPayload {
  return {
    requestId,
    userId,
    apiKeyId,
    accountId,
    orgId,
    teamId: null,
    requestedModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5-20250101",
    platform: "anthropic",
    surface: "messages",
    stream: false,
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputCost: "0.0010000000",
    outputCost: "0.0020000000",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    totalCost,
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    statusCode: 200,
    durationMs: 1234,
    firstTokenMs: null,
    bufferReleasedAtMs: null,
    upstreamRetries: 0,
    failedAccountIds: [],
    userAgent: null,
    ipAddress: null,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("writeUsageLogBatch — standalone helper", () => {
  it("inserts a single payload and bumps quota_used_usd in one txn", async () => {
    const key = await seedApiKey("k-single");
    const payload = makePayload(key.id, "0.0420000000", "req-single-1");

    await writeUsageLogBatch(db, [payload]);

    // Row landed in usage_logs with the right request_id + cost.
    const rows = await db
      .select({
        requestId: usageLogs.requestId,
        totalCost: usageLogs.totalCost,
        apiKeyId: usageLogs.apiKeyId,
      })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, "req-single-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.apiKeyId).toBe(key.id);
    expect(Number(rows[0]!.totalCost)).toBeCloseTo(0.042, 8);

    // Quota bumped.
    const [keyRow] = await db
      .select({ used: apiKeys.quotaUsedUsd, lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, key.id));
    expect(Number(keyRow!.used)).toBeCloseTo(0.042, 8);
    // last_used_at was set by the UPDATE (NOW()).
    expect(keyRow!.lastUsedAt).not.toBeNull();
  });

  it("is a no-op for an empty payload list", async () => {
    // Empty input must not open a txn or touch any table.
    await writeUsageLogBatch(db, []);
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usageLogs);
    expect(rows[0]!.count).toBe(0);
  });

  it("rejects on duplicate request_id (UNIQUE constraint, txn rolls back)", async () => {
    // Documents the retry caveat called out in writeUsageLogBatch.ts: there
    // is no onConflictDoNothing, so a duplicate request_id aborts the whole
    // txn.  This is intentional — silently accepting would double-charge
    // quota_used_usd on the inline-fallback retry path.
    const key = await seedApiKey("k-dup");
    const payload = makePayload(key.id, "0.0100000000", "req-dup-1");

    await writeUsageLogBatch(db, [payload]);
    await expect(writeUsageLogBatch(db, [payload])).rejects.toThrow();

    // Only one row, only one quota bump — the failed retry rolled back.
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usageLogs)
      .where(eq(usageLogs.requestId, "req-dup-1"));
    expect(rows[0]!.count).toBe(1);

    const [keyRow] = await db
      .select({ used: apiKeys.quotaUsedUsd })
      .from(apiKeys)
      .where(eq(apiKeys.id, key.id));
    expect(Number(keyRow!.used)).toBeCloseTo(0.01, 8);
  });
});

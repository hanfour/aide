import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "../../factories/db.js";
import { makeOrg } from "../../factories/org.js";
import { makeUser } from "../../factories/user.js";
import { getFacetSummary } from "../../../src/services/facetSummary.js";

/**
 * Plan 4C follow-up #3 — getFacetSummary service test.
 *
 * Exercises the join from `request_body_facets` → `usage_logs` and the
 * window-bounded aggregation that drives the report-page drill-down.
 */
describe("getFacetSummary (integration)", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`
      TRUNCATE
        request_body_facets,
        request_bodies,
        usage_logs,
        api_keys,
        upstream_accounts,
        users,
        organizations
      RESTART IDENTITY CASCADE
    `);
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Insert one (usage_log, request_body, request_body_facet) row for the
   * given user/org with the given facet payload at the given timestamp.
   * Returns the requestId so the caller can chain inserts off it.
   */
  async function insertFacet(args: {
    orgId: string;
    userId: string;
    when: Date;
    sessionType?: string | null;
    outcome?: string | null;
    claudeHelpfulness?: number | null;
    frictionCount?: number | null;
    bugsCaughtCount?: number | null;
    codexErrorsCount?: number | null;
    extractionError?: string | null;
  }): Promise<string> {
    const requestId = `req-${Math.random().toString(36).slice(2, 12)}`;

    // 1. Ensure upstream_account + api_key exist for this org.
    //    upstream_accounts requires: name, platform, type.
    //    api_keys requires: key_hash (unique), key_prefix, name.
    const accountRows = await testDb.db.execute<{ id: string }>(sql`
      SELECT id FROM upstream_accounts WHERE org_id = ${args.orgId} LIMIT 1
    `);
    let accountId: string;
    if (accountRows.rows.length === 0) {
      const inserted = await testDb.db.execute<{ id: string }>(sql`
        INSERT INTO upstream_accounts (org_id, name, platform, type)
        VALUES (${args.orgId}, 'test-account', 'anthropic', 'oauth')
        RETURNING id
      `);
      accountId = inserted.rows[0]!.id;
    } else {
      accountId = accountRows.rows[0]!.id;
    }

    const apiKeyRows = await testDb.db.execute<{ id: string }>(sql`
      SELECT id FROM api_keys WHERE org_id = ${args.orgId} LIMIT 1
    `);
    let apiKeyId: string;
    if (apiKeyRows.rows.length === 0) {
      const keyHash = `h-${Math.random().toString(36).slice(2, 12)}`;
      const inserted = await testDb.db.execute<{ id: string }>(sql`
        INSERT INTO api_keys (org_id, user_id, key_hash, key_prefix, name)
        VALUES (${args.orgId}, ${args.userId}, ${keyHash}, 'pf', 'test-key')
        RETURNING id
      `);
      apiKeyId = inserted.rows[0]!.id;
    } else {
      apiKeyId = apiKeyRows.rows[0]!.id;
    }

    // 2. usage_log — minimum required columns: requested_model,
    //    upstream_model, platform, surface, status_code, duration_ms.
    await testDb.db.execute(sql`
      INSERT INTO usage_logs
        (request_id, user_id, org_id, account_id, api_key_id,
         requested_model, upstream_model, platform, surface,
         status_code, duration_ms, created_at)
      VALUES
        (${requestId}, ${args.userId}, ${args.orgId}, ${accountId}, ${apiKeyId},
         'claude-haiku-4-5', 'claude-haiku-4-5', 'anthropic', 'messages',
         200, 1234, ${args.when})
    `);

    // 2. request_body — minimum required columns.
    await testDb.db.execute(sql`
      INSERT INTO request_bodies
        (request_id, org_id, request_body_sealed, response_body_sealed, retention_until)
      VALUES
        (${requestId}, ${args.orgId}, '\\x', '\\x', now() + interval '90 days')
    `);

    // 3. request_body_facets — the row under test.
    await testDb.db.execute(sql`
      INSERT INTO request_body_facets
        (request_id, org_id, session_type, outcome, claude_helpfulness,
         friction_count, bugs_caught_count, codex_errors_count,
         extracted_with_model, prompt_version, extraction_error)
      VALUES
        (${requestId}, ${args.orgId},
         ${args.sessionType ?? null},
         ${args.outcome ?? null},
         ${args.claudeHelpfulness ?? null},
         ${args.frictionCount ?? null},
         ${args.bugsCaughtCount ?? null},
         ${args.codexErrorsCount ?? null},
         'claude-haiku-4-5', 1,
         ${args.extractionError ?? null})
    `);

    return requestId;
  }

  // ── Tests ──────────────────────────────────────────────────────────────

  it("returns the empty summary when no facet rows match the window", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db);

    const s = await getFacetSummary(
      testDb.db,
      org.id,
      user.id,
      new Date("2026-04-01T00:00:00Z"),
      new Date("2026-04-30T23:59:59Z"),
    );

    expect(s).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      avgClaudeHelpfulness: null,
      totalFrictionCount: null,
      totalBugsCaught: null,
      totalCodexErrors: null,
      sessionTypeCounts: {},
      outcomeSuccessRate: null,
    });
  });

  it("aggregates a mix of successful and failed extractions", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db);

    // 3 successful + 1 failed, all within the window.
    await insertFacet({
      orgId: org.id,
      userId: user.id,
      when: new Date("2026-04-05T10:00:00Z"),
      sessionType: "feature_dev",
      outcome: "success",
      claudeHelpfulness: 5,
      frictionCount: 0,
      bugsCaughtCount: 1,
      codexErrorsCount: 0,
    });
    await insertFacet({
      orgId: org.id,
      userId: user.id,
      when: new Date("2026-04-10T10:00:00Z"),
      sessionType: "bug_fix",
      outcome: "partial",
      claudeHelpfulness: 4,
      frictionCount: 1,
      bugsCaughtCount: 2,
      codexErrorsCount: 1,
    });
    await insertFacet({
      orgId: org.id,
      userId: user.id,
      when: new Date("2026-04-15T10:00:00Z"),
      sessionType: "feature_dev",
      outcome: "failure",
      claudeHelpfulness: 2,
      frictionCount: 3,
      bugsCaughtCount: 0,
      codexErrorsCount: 2,
    });
    await insertFacet({
      orgId: org.id,
      userId: user.id,
      when: new Date("2026-04-20T10:00:00Z"),
      extractionError: "parse_error: bad json",
    });

    const s = await getFacetSummary(
      testDb.db,
      org.id,
      user.id,
      new Date("2026-04-01T00:00:00Z"),
      new Date("2026-04-30T23:59:59Z"),
    );

    expect(s.total).toBe(4);
    expect(s.succeeded).toBe(3);
    expect(s.failed).toBe(1);
    expect(s.avgClaudeHelpfulness).toBeCloseTo((5 + 4 + 2) / 3, 6);
    expect(s.totalFrictionCount).toBe(0 + 1 + 3);
    expect(s.totalBugsCaught).toBe(1 + 2 + 0);
    expect(s.totalCodexErrors).toBe(0 + 1 + 2);
    expect(s.sessionTypeCounts).toEqual({ feature_dev: 2, bug_fix: 1 });
    expect(s.outcomeSuccessRate).toBeCloseTo(2 / 3, 6); // 2 (success+partial) / 3 non-null outcomes
  });

  it("excludes rows outside the window", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db);

    await insertFacet({
      orgId: org.id,
      userId: user.id,
      when: new Date("2026-03-31T23:59:59Z"), // before window
      sessionType: "feature_dev",
      outcome: "success",
      claudeHelpfulness: 5,
      frictionCount: 0,
      bugsCaughtCount: 0,
      codexErrorsCount: 0,
    });
    await insertFacet({
      orgId: org.id,
      userId: user.id,
      when: new Date("2026-04-15T10:00:00Z"), // inside
      sessionType: "feature_dev",
      outcome: "success",
      claudeHelpfulness: 4,
      frictionCount: 0,
      bugsCaughtCount: 0,
      codexErrorsCount: 0,
    });
    await insertFacet({
      orgId: org.id,
      userId: user.id,
      when: new Date("2026-05-01T00:00:00Z"), // after window
      sessionType: "feature_dev",
      outcome: "success",
      claudeHelpfulness: 3,
      frictionCount: 0,
      bugsCaughtCount: 0,
      codexErrorsCount: 0,
    });

    const s = await getFacetSummary(
      testDb.db,
      org.id,
      user.id,
      new Date("2026-04-01T00:00:00Z"),
      new Date("2026-04-30T23:59:59Z"),
    );

    expect(s.total).toBe(1);
    expect(s.avgClaudeHelpfulness).toBe(4);
  });

  it("excludes rows for other users", async () => {
    const org = await makeOrg(testDb.db);
    const userA = await makeUser(testDb.db);
    const userB = await makeUser(testDb.db);

    await insertFacet({
      orgId: org.id,
      userId: userA.id,
      when: new Date("2026-04-05T10:00:00Z"),
      sessionType: "feature_dev",
      claudeHelpfulness: 5,
    });
    await insertFacet({
      orgId: org.id,
      userId: userB.id,
      when: new Date("2026-04-05T10:00:00Z"),
      sessionType: "feature_dev",
      claudeHelpfulness: 1,
    });

    const sA = await getFacetSummary(
      testDb.db,
      org.id,
      userA.id,
      new Date("2026-04-01T00:00:00Z"),
      new Date("2026-04-30T23:59:59Z"),
    );

    expect(sA.total).toBe(1);
    expect(sA.avgClaudeHelpfulness).toBe(5);
  });
});

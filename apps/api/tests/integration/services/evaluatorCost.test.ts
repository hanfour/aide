import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "../../factories/db.js";
import { makeOrg } from "../../factories/org.js";
import { getCostSummary } from "../../../src/services/evaluatorCost.js";

describe("getCostSummary (integration)", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  }, 60_000);
  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.execute(
      sql`TRUNCATE organizations, llm_usage_events CASCADE`,
    );
  });

  async function seedOrgWithBudget(budget: number | null) {
    const org = await makeOrg(testDb.db);
    if (budget !== null) {
      await testDb.db.execute(sql`
        UPDATE organizations SET llm_monthly_budget_usd = ${budget} WHERE id = ${org.id}
      `);
    }
    return org.id;
  }

  it("returns zeros when no usage", async () => {
    const orgId = await seedOrgWithBudget(50);
    const s = await getCostSummary(
      testDb.db,
      orgId,
      new Date("2026-04-15T12:00:00Z"),
    );
    expect(s.currentMonthSpendUsd).toBe(0);
    expect(s.budgetUsd).toBe(50);
    expect(s.remainingUsd).toBe(50);
    expect(s.breakdown.facetExtraction.calls).toBe(0);
    expect(s.breakdown.deepAnalysis.calls).toBe(0);
    expect(s.warningThresholdReached).toBe(false);
    expect(s.halted).toBe(false);
  });

  it("aggregates by event_type and model", async () => {
    const orgId = await seedOrgWithBudget(50);
    await testDb.db.execute(sql`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd, created_at)
      VALUES
        (${orgId}, 'facet_extraction', 'claude-haiku-4-5', 100, 50, 1.00, '2026-04-05T00:00:00Z'),
        (${orgId}, 'facet_extraction', 'claude-haiku-4-5', 200, 50, 2.00, '2026-04-10T00:00:00Z'),
        (${orgId}, 'deep_analysis',    'claude-sonnet-4-6', 500, 100, 5.00, '2026-04-12T00:00:00Z')
    `);

    const s = await getCostSummary(
      testDb.db,
      orgId,
      new Date("2026-04-15T12:00:00Z"),
    );
    expect(s.currentMonthSpendUsd).toBeCloseTo(8, 6);
    expect(s.breakdown.facetExtraction.calls).toBe(2);
    expect(s.breakdown.facetExtraction.costUsd).toBeCloseTo(3, 6);
    expect(s.breakdown.deepAnalysis.calls).toBe(1);
    expect(s.breakdown.deepAnalysis.costUsd).toBeCloseTo(5, 6);
    expect(s.breakdownByModel.length).toBe(2);
    // Sorted by total desc — sonnet ($5) before haiku ($3)
    expect(s.breakdownByModel[0]!.model).toBe("claude-sonnet-4-6");
    expect(s.breakdownByModel[0]!.calls).toBe(1);
    expect(s.breakdownByModel[0]!.costUsd).toBeCloseTo(5, 6);
    expect(s.breakdownByModel[1]!.model).toBe("claude-haiku-4-5");
  });

  it("only counts current UTC month", async () => {
    const orgId = await seedOrgWithBudget(50);
    await testDb.db.execute(sql`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd, created_at)
      VALUES
        (${orgId}, 'facet_extraction', 'claude-haiku-4-5', 1, 1, 100.00, '2026-03-31T23:59:00Z'),
        (${orgId}, 'facet_extraction', 'claude-haiku-4-5', 1, 1, 1.00, '2026-04-15T00:00:00Z'),
        (${orgId}, 'facet_extraction', 'claude-haiku-4-5', 1, 1, 50.00, '2026-05-01T00:00:00Z')
    `);
    const s = await getCostSummary(
      testDb.db,
      orgId,
      new Date("2026-04-15T12:00:00Z"),
    );
    expect(s.currentMonthSpendUsd).toBeCloseTo(1, 6);
  });

  it("computes projected end-of-month linearly", async () => {
    const orgId = await seedOrgWithBudget(50);
    await testDb.db.execute(sql`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd, created_at)
      VALUES (${orgId}, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 10.00, '2026-04-10T00:00:00Z')
    `);
    // April has 30 days; on day 15 at 12:00 UTC, elapsed ~ 14.5 days
    // projected ~ 10 * 30 / 14.5 ~ 20.69
    const s = await getCostSummary(
      testDb.db,
      orgId,
      new Date("2026-04-15T12:00:00Z"),
    );
    expect(s.projectedEndOfMonthUsd).toBeGreaterThan(20);
    expect(s.projectedEndOfMonthUsd).toBeLessThan(22);
  });

  it("flags warningThresholdReached when spend >= 80% of budget", async () => {
    const orgId = await seedOrgWithBudget(50);
    await testDb.db.execute(sql`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd, created_at)
      VALUES (${orgId}, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 40.00, '2026-04-05T00:00:00Z')
    `);
    const s = await getCostSummary(
      testDb.db,
      orgId,
      new Date("2026-04-15T12:00:00Z"),
    );
    expect(s.warningThresholdReached).toBe(true);
  });

  it("returns budget=null and remainingUsd=null when budget is unlimited", async () => {
    const orgId = await seedOrgWithBudget(null);
    const s = await getCostSummary(
      testDb.db,
      orgId,
      new Date("2026-04-15T12:00:00Z"),
    );
    expect(s.budgetUsd).toBeNull();
    expect(s.remainingUsd).toBeNull();
    expect(s.warningThresholdReached).toBe(false);
  });

  it("includes last 6 months historical totals (most recent first or chronological)", async () => {
    const orgId = await seedOrgWithBudget(50);
    await testDb.db.execute(sql`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd, created_at)
      VALUES
        (${orgId}, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 5.00, '2025-11-15T00:00:00Z'),
        (${orgId}, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 3.00, '2026-02-15T00:00:00Z')
    `);
    const s = await getCostSummary(
      testDb.db,
      orgId,
      new Date("2026-04-15T12:00:00Z"),
    );
    expect(s.historicalMonths).toHaveLength(6);
    const nov = s.historicalMonths.find((m) => m.month === "2025-11");
    expect(nov).toBeDefined();
    expect(nov!.costUsd).toBeCloseTo(5, 6);
    const feb = s.historicalMonths.find((m) => m.month === "2026-02");
    expect(feb!.costUsd).toBeCloseTo(3, 6);
  });

  it("reflects halted=true when llm_halted_until_month_end is set", async () => {
    const orgId = await seedOrgWithBudget(50);
    await testDb.db.execute(sql`
      UPDATE organizations SET llm_halted_until_month_end = true WHERE id = ${orgId}
    `);
    const s = await getCostSummary(
      testDb.db,
      orgId,
      new Date("2026-04-15T12:00:00Z"),
    );
    expect(s.halted).toBe(true);
  });
});

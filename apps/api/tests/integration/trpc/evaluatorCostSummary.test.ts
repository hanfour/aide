import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  callerFor,
  type TestDb,
} from "../../factories/index.js";

let t: TestDb;

beforeAll(async () => {
  t = await setupTestDb();
}, 60_000);

afterAll(async () => {
  await t.stop();
});

describe("evaluator.costSummary tRPC procedure", () => {
  it("returns cost summary for org_admin of the org", async () => {
    const org = await makeOrg(t.db);
    await t.db.execute(sql`
      UPDATE organizations
      SET llm_monthly_budget_usd = 50
      WHERE id = ${org.id}
    `);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });

    const caller = await callerFor(t.db, admin.id);
    const summary = await caller.evaluator.costSummary({ orgId: org.id });

    expect(summary.budgetUsd).toBe(50);
    expect(summary.currentMonthSpendUsd).toBe(0);
    expect(summary.remainingUsd).toBe(50);
    expect(summary.halted).toBe(false);
    expect(summary.warningThresholdReached).toBe(false);
    expect(summary.breakdown.facetExtraction.calls).toBe(0);
    expect(summary.breakdown.deepAnalysis.calls).toBe(0);
    expect(summary.breakdownByModel).toEqual([]);
    expect(summary.historicalMonths).toHaveLength(6);
  });

  it("rejects a member of the same org with FORBIDDEN", async () => {
    const org = await makeOrg(t.db);
    const member = await makeUser(t.db, { orgId: org.id });

    const caller = await callerFor(t.db, member.id);
    await expect(
      caller.evaluator.costSummary({ orgId: org.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects org_admin of a different org with FORBIDDEN", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const adminA = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });

    const caller = await callerFor(t.db, adminA.id);
    await expect(
      caller.evaluator.costSummary({ orgId: orgB.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("super_admin can view cost for any org", async () => {
    const org = await makeOrg(t.db);
    const superAdmin = await makeUser(t.db, {
      role: "super_admin",
      scopeType: "global",
      scopeId: null,
    });

    const caller = await callerFor(t.db, superAdmin.id);
    const summary = await caller.evaluator.costSummary({ orgId: org.id });

    expect(summary).toBeDefined();
    expect(summary.currentMonthSpendUsd).toBe(0);
    expect(summary.budgetUsd).toBeNull();
    expect(summary.halted).toBe(false);
  });
});

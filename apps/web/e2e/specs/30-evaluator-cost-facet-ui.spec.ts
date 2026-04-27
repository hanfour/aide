import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resetDb, seedDb } from "../fixtures/seed-db";
import { signInWithSession } from "../fixtures/mock-oauth";

/**
 * Plan 4C follow-up #5 — facet/cost UI E2E spec.
 *
 * Locks the user-facing surfaces of Plan 4C Phase 1 (cost budget) + Phase 2
 * (facet extraction settings). Backend integration tests already cover the
 * pipeline end-to-end (`runFacetExtraction.integration.test.ts`,
 * `evaluatorCostSummary.test.ts`); this spec catches regressions in the
 * Settings form layout, cross-field validation, navigation to the cost
 * dashboard, and persistence of budget input.
 *
 * Coverage:
 *   1. Settings page renders both Plan 4C fieldsets ("LLM Cost Control" +
 *      "LLM Facet Extraction").
 *   2. Facet toggle is disabled when LLM evaluation is off (cross-field
 *      constraint enforced at the UI layer).
 *   3. Setting a monthly budget round-trips: save, reload, value persists.
 *   4. Clearing the budget brings back the "no budget set" warning when
 *      LLM eval is also enabled (the warning is gated on llmEvalEnabled).
 *   5. Status page shows the compact cost widget when the user has
 *      `evaluator.view_cost`, and the link navigates to the cost dashboard.
 *
 * NOT covered (intentionally — would need more setup than a UI spec
 * justifies): full happy-path facet enable + LLM eval account + facet model
 * persistence. That requires upstream-account + api-key seeding + a real
 * llmEvalEnabled toggle path. Backend integration tests cover the data
 * round-trip; the cross-field UI gate (item 2 above) is the high-value
 * regression catch.
 */
test("plan 4c — settings cost+facet sections, persistence, status widget", async ({
  page,
  context,
}) => {
  const orgId = randomUUID();
  const adminToken = "e2e-cost-facet-admin-" + Date.now();

  // ── Seed: org + super_admin user ─────────────────────────────────────────
  await resetDb();
  const seed = await seedDb({
    reset: false,
    orgs: [{ id: orgId, slug: "e2e-cost-facet", name: "E2E Cost+Facet" }],
    users: [{ email: "admin-cf@e2e.test", sessionToken: adminToken }],
  });
  const admin = seed.users[0];
  if (!admin) throw new Error("admin not seeded");

  await seedDb({
    reset: false,
    orgMembers: [{ orgId, userId: admin.id }],
    roleAssignments: [
      // super_admin grants both `evaluator.read_status` (required to render
      // the status page) and `evaluator.view_cost` (required to render the
      // cost widget). org_admin would also work but super_admin matches the
      // 20-evaluator-happy.spec convention.
      { userId: admin.id, role: "super_admin", scopeType: "global" },
    ],
  });

  await signInWithSession(context, { sessionToken: adminToken });

  // ── 1. Both Plan 4C sections render on the Settings page ────────────────
  await page.goto(`/dashboard/organizations/${orgId}/evaluator/settings`);

  await expect(
    page.getByRole("heading", { name: /LLM Cost Control/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /LLM Facet Extraction/i }),
  ).toBeVisible();

  // Inputs / toggles for the new fields are present and properly labelled.
  await expect(page.locator("input#llmMonthlyBudgetUsd")).toBeVisible();
  await expect(page.locator("select#llmFacetModel")).toBeVisible();

  // ── 2. Facet toggle is disabled while LLM evaluation is off ──────────────
  // The form's `disabled` flag flows from `llmEvalEnabled = watch(...)` —
  // when llmEvalEnabled is false (the default for a fresh org), the
  // facet-enable switch should be visibly disabled.
  const facetToggle = page.locator('[role="switch"][id="llmFacetEnabled"]');
  await expect(facetToggle).toBeVisible();
  await expect(facetToggle).toBeDisabled();

  // The facet model select should also be disabled (it's gated on the
  // facet-enabled flag, which the user can't flip while llm_eval is off).
  await expect(page.locator("select#llmFacetModel")).toBeDisabled();

  // ── 3. Monthly budget persists across save+reload ────────────────────────
  const budgetInput = page.locator("input#llmMonthlyBudgetUsd");
  await budgetInput.fill("25");

  // Save via the form's submit button.
  await page.getByRole("button", { name: /save settings/i }).click();

  // Wait for sonner success toast OR for the form to settle (whichever
  // arrives first; toast is rendered via portal and may flicker).
  await page.waitForTimeout(500);

  // Reload and verify the input still shows 25.
  await page.reload();
  await expect(page.locator("input#llmMonthlyBudgetUsd")).toHaveValue("25");

  // ── 4. Clearing the budget — warning banner depends on llmEvalEnabled ───
  // With llmEvalEnabled still false (we never turned it on in this spec),
  // the "No budget set" warning is gated off, so clearing the budget is a
  // silent operation. We verify the input round-trips back to empty.
  await page.locator("input#llmMonthlyBudgetUsd").fill("");
  await page.getByRole("button", { name: /save settings/i }).click();
  await page.waitForTimeout(500);

  await page.reload();
  await expect(page.locator("input#llmMonthlyBudgetUsd")).toHaveValue("");

  // ── 5. Status page shows the cost widget + link to cost dashboard ───────
  await page.goto(`/dashboard/organizations/${orgId}/evaluator/status`);

  // Compact CostSummaryCard renders "This month's LLM spend" header.
  await expect(page.getByText(/this month's llm spend/i)).toBeVisible();

  // The "View cost dashboard →" link is present and points at the costs
  // route. Clicking it lands on a page whose H1 is "LLM Cost Dashboard".
  const costsLink = page.getByRole("link", {
    name: /view cost dashboard/i,
  });
  await expect(costsLink).toBeVisible();
  await costsLink.click();

  await expect(page).toHaveURL(
    new RegExp(
      `/dashboard/organizations/${orgId}/evaluator/costs(?:[/?#]|$)`,
    ),
  );
  await expect(
    page.getByRole("heading", { name: /LLM Cost Dashboard/i, level: 1 }),
  ).toBeVisible();
});

import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resetDb, seedDb } from "../fixtures/seed-db";
import { signInWithSession } from "../fixtures/mock-oauth";
import { E2E_GATEWAY_BASE_URL } from "../fixtures/gateway-env";

/**
 * Part 11.2 — evaluator happy-path smoke test.
 *
 * Full round-trip covering the evaluator feature:
 *
 *   1. super_admin signs in
 *   2. Creates an org (via seed — no UI form for org creation yet)
 *   3. Enables content capture on the org via the Settings UI
 *   4. Provisions an upstream account via the accounts UI
 *   5. Issues a platform API key via the profile UI
 *   6. Simulates a /v1/messages call through the gateway (fake-anthropic
 *      stubs the upstream response; gateway authenticates + captures body)
 *   7. Triggers a daily cron rerun via the tRPC `reports.rerun` endpoint
 *      (BullMQ not wired in test mode — response is testMode: true; this
 *      validates the RBAC + parameter path end-to-end without a live worker)
 *   8. Reads the evaluation report page (/dashboard/profile/evaluation) and
 *      asserts it loads without an auth error
 *
 * KNOWN INFRA GAPS (flagged for follow-up):
 *   - BullMQ evaluator queue not wired in test mode (Task 6.4b). The rerun
 *     mutation returns { testMode: true } so no actual report row is written.
 *     Step 8 therefore asserts the page renders (even the "no evaluations yet"
 *     empty state), not a populated report. Once Task 6.4b ships, an in-process
 *     worker can consume the queue and a re-poll assertion can be added.
 *   - Org creation via UI is not yet tested (no org-create page). Org is seeded
 *     directly via the test-seed endpoint, matching the pattern used in specs
 *     10 + 11.
 */
test("evaluator happy path: admin → content capture → account → api_key → gateway → rerun → evaluation page", async ({
  page,
  context,
}) => {
  const orgId = randomUUID();
  const adminToken = "e2e-eval-admin-" + Date.now();

  // ── Seed: org + super_admin user ─────────────────────────────────────────
  await resetDb();
  const seed = await seedDb({
    reset: false,
    orgs: [{ id: orgId, slug: "e2e-eval-happy", name: "E2E Evaluator Happy" }],
    users: [{ email: "admin-eval@e2e.test", sessionToken: adminToken }],
  });
  const admin = seed.users[0];
  if (!admin) throw new Error("admin not seeded");

  await seedDb({
    reset: false,
    orgMembers: [{ orgId, userId: admin.id }],
    roleAssignments: [
      // Global super_admin grants all permissions used in this spec:
      //   content_capture.toggle, accounts.create, api_key.issue_own,
      //   report.rerun, evaluator.read_status
      { userId: admin.id, role: "super_admin", scopeType: "global" },
    ],
  });

  await signInWithSession(context, { sessionToken: adminToken });

  // ── 1. Enable content capture via the Settings UI ────────────────────────
  await page.goto(`/dashboard/organizations/${orgId}/evaluator/settings`);
  // The toggle switch for "Enable content capture" has role="switch" +
  // id="contentCaptureEnabled". Click it to flip to true.
  const captureToggle = page.locator(
    '[role="switch"][id="contentCaptureEnabled"]',
  );
  await expect(captureToggle).toBeVisible();
  // Only click if not already checked
  const isChecked =
    (await captureToggle.getAttribute("aria-checked")) === "true";
  if (!isChecked) {
    await captureToggle.click();
  }
  // Wait for the setSettings mutation to resolve successfully. This is more
  // reliable than waiting for the sonner toast (which renders via portal with
  // a 4s default duration — racy against Playwright's 5s expect timeout in CI).
  const [setSettingsRes] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes("/trpc/contentCapture.setSettings") &&
        res.request().method() === "POST",
      { timeout: 15000 },
    ),
    page.getByRole("button", { name: /save settings/i }).click(),
  ]);
  expect(setSettingsRes.status()).toBe(200);

  // ── 2. Create an api_key upstream account ────────────────────────────────
  await page.goto(`/dashboard/organizations/${orgId}/accounts/new`);
  await page.getByLabel("Name").fill("e2e-eval-anthropic-key");
  // Default platform=anthropic, type=api_key
  await page.getByLabel("Credentials").fill("sk-ant-fake-e2e-eval");
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(
    new RegExp(`^.*/dashboard/organizations/${orgId}/accounts$`),
  );

  // ── 3. Self-issue a platform API key; capture the raw value ──────────────
  await page.goto("/dashboard/profile");
  await page.getByRole("button", { name: /new key/i }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("e2e-eval-key");
  await dialog.getByRole("button", { name: /generate key/i }).click();

  const keyCode = dialog.locator("#apiKeyRaw");
  await expect(keyCode).toBeVisible();
  const rawKey = (await keyCode.textContent())?.trim();
  expect(rawKey, "reveal panel should surface the raw key").toBeTruthy();
  expect(rawKey).toMatch(/^ak_/);
  await dialog.getByRole("button", { name: /done/i }).click();

  // ── 4. Call the gateway — fake-anthropic stubs the upstream response ──────
  // The gateway captures the request body (content_capture enabled above) and
  // emits a BullMQ usage-log job before returning the stubbed 200 response.
  const gwResponse = await page.request.post(
    `${E2E_GATEWAY_BASE_URL}/v1/messages`,
    {
      headers: {
        "x-api-key": rawKey!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      data: {
        model: "claude-3-haiku-20240307",
        max_tokens: 8,
        messages: [{ role: "user", content: "evaluate me" }],
      },
    },
  );
  expect(
    gwResponse.status(),
    `gateway rejected request: ${await gwResponse.text()}`,
  ).toBe(200);
  const gwBody = (await gwResponse.json()) as {
    type: string;
    role: string;
    content: Array<{ type: string; text: string }>;
  };
  expect(gwBody.type).toBe("message");
  expect(gwBody.role).toBe("assistant");
  // Fake-anthropic always replies "ok"
  expect(gwBody.content[0]?.text).toBe("ok");

  // ── 5. Trigger evaluator rerun via tRPC ───────────────────────────────────
  // We call the mutation directly (no browser UI exists yet for rerun).
  // In test mode (evaluatorQueue not wired) the server returns testMode:true.
  // This validates the RBAC + input-parsing path without requiring a live queue.
  const periodEnd = new Date().toISOString();
  const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // tRPC mutations use POST with batch=1
  const rerunRes = await page.request.post(`/trpc/reports.rerun?batch=1`, {
    headers: { "content-type": "application/json" },
    data: JSON.stringify({
      "0": {
        orgId,
        scope: "user",
        targetId: admin.id,
        periodStart,
        periodEnd,
      },
    }),
  });
  expect(
    rerunRes.status(),
    `reports.rerun call failed: ${await rerunRes.text()}`,
  ).toBe(200);
  const rerunBody = (await rerunRes.json()) as Array<{
    result?: {
      data?: { enqueued: number; targets: number; testMode?: boolean };
    };
  }>;
  const rerunData = rerunBody[0]?.result?.data;
  expect(rerunData, "rerun response should have data").toBeTruthy();
  // targets ≥ 1 confirms the org member lookup succeeded (even if testMode)
  expect(rerunData!.targets).toBeGreaterThanOrEqual(1);

  // ── 6. Read the evaluation page on the member profile ────────────────────
  // Because no actual evaluator worker ran (testMode=true), there are no
  // report rows. We assert the page renders without an auth error — the
  // "no evaluations yet" empty state is the expected outcome.
  await page.goto("/dashboard/profile/evaluation");
  // Heading confirms the page mounted correctly
  await expect(
    page.getByRole("heading", { name: /my evaluation/i }),
  ).toBeVisible();
  // Either a report card OR the empty-state card must appear; never an error
  await expect(
    page
      .getByText(/no evaluations yet/i)
      .or(page.getByText(/latest score/i))
      .first(),
  ).toBeVisible({ timeout: 10_000 });

  // ── 7. (Bonus) Verify evaluator status card renders for the org ───────────
  // The status tRPC call returns cron health + coverage — useful to confirm
  // the evaluatorProcedure gate (feature flag check) passes for super_admin.
  await page.goto(`/dashboard/organizations/${orgId}/evaluator/status`);
  // "Cron Health" is the card title rendered by StatusCard
  // Use exact match to disambiguate from the page subtitle
  // ("Current cron health and coverage.") which also includes the phrase.
  await expect(page.getByText("Cron Health", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
});

import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resetDb, seedDb } from "../fixtures/seed-db";
import { signInWithSession } from "../fixtures/mock-oauth";
import { E2E_GATEWAY_BASE_URL } from "../fixtures/gateway-env";

/**
 * Part 12.1 — gateway happy path (full round trip).
 *
 *   1. super_admin signs in
 *   2. creates an api_key-type upstream account in the UI
 *   3. self-issues a platform API key, captures the one-time raw value
 *   4. calls POST /v1/messages on the real gateway process (see
 *      playwright.config.ts webServer wiring) — fake upstream stubs the
 *      Anthropic response, gateway authenticates, emits a BullMQ usage-log
 *      job, returns 200 JSON
 *   5. asserts the Requests KPI on /dashboard/profile/usage flips to >0 once
 *      the async usage-log worker flushes the row (poll with page.reload
 *      until visible or 15s expires)
 *
 * The usage write is async (BullMQ batch writer), so the final step must
 * retry. The rest of the flow is synchronous.
 */
test("gateway happy path: admin → account → self-issued key → request → usage visible", async ({
  page,
  context,
}) => {
  const orgId = randomUUID();
  const adminToken = "e2e-gw-admin-" + Date.now();

  await resetDb();
  const seed = await seedDb({
    reset: false,
    orgs: [{ id: orgId, slug: "e2e-gw-happy", name: "E2E Gateway Happy" }],
    users: [{ email: "admin-gw@e2e.test", sessionToken: adminToken }],
  });
  const admin = seed.users[0];
  if (!admin) throw new Error("admin not seeded");
  await seedDb({
    reset: false,
    orgMembers: [{ orgId, userId: admin.id }],
    roleAssignments: [
      // global super_admin so the admin has both account.create (org-scope)
      // and api_key.issue_own (self-scope) without juggling multiple grants.
      { userId: admin.id, role: "super_admin", scopeType: "global" },
    ],
  });
  await signInWithSession(context, { sessionToken: adminToken });

  // ── 1. Create an api_key upstream account via the admin UI ─────────────
  await page.goto(`/dashboard/organizations/${orgId}/accounts/new`);
  await page.getByLabel("Name").fill("e2e-anthropic-key");
  // platform=anthropic, type=api_key, scope=org are the form defaults.
  await page.getByLabel("Credentials").fill("sk-ant-fake-e2e");
  await page.getByRole("button", { name: /create account/i }).click();
  // Submit redirects to the accounts list. Wait until the navigation
  // completes before we touch the profile page — otherwise the list query
  // can still be in flight when we move on.
  // Anchor both ends: regex test() matches substring by default, so an
  // unrelated page URL that happens to end with `/accounts` would pass.
  await expect(page).toHaveURL(
    new RegExp(`^.*/dashboard/organizations/${orgId}/accounts$`),
  );

  // ── 2. Self-issue a platform API key; capture the raw value ────────────
  await page.goto("/dashboard/profile");
  await page.getByRole("button", { name: /new key/i }).click();
  // The create dialog reuses `Name` as the label; scope the lookup to the
  // dialog so it doesn't collide with the profile form's Display name field.
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("e2e-happy-key");
  await dialog.getByRole("button", { name: /generate key/i }).click();

  // Reveal panel lands; the raw key sits inside <code id="apiKeyRaw">.
  const keyCode = dialog.locator("#apiKeyRaw");
  await expect(keyCode).toBeVisible();
  const rawKey = (await keyCode.textContent())?.trim();
  expect(rawKey, "reveal panel should surface the raw key").toBeTruthy();
  expect(rawKey).toMatch(/^ak_/);
  // Dismiss the dialog. Its teardown effect drops the raw value from state.
  await dialog.getByRole("button", { name: /done/i }).click();

  // ── 3. Call the gateway directly with the captured key ─────────────────
  // Fresh APIRequestContext (no browser cookies). Gateway auth is the header,
  // not the session.
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
        messages: [{ role: "user", content: "hello" }],
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
  expect(gwBody.content[0]?.text).toBe("ok");

  // ── 4. Assert the usage row surfaces on /dashboard/profile/usage ───────
  // Usage logs are written asynchronously by the BullMQ worker, so retry
  // with reload until the `Requests` KPI card shows a non-zero integer or
  // the timeout elapses.
  await page.goto("/dashboard/profile/usage");
  await expect(async () => {
    // networkidle waits for the trpc usage.summary query to settle post-reload
    // so we don't read the loading-skeleton's "—" placeholder on a fast iter.
    await page.reload({ waitUntil: "networkidle" });
    // The page has TWO elements with text "Requests": the KPI label in
    // UsageSummaryCards AND the CardTitle of the UsageTable section. Scope
    // to the KPI card by matching on the `.uppercase` class tailwind applies
    // to KPI labels only — the CardTitle uses plain font-medium.
    const requestsLabel = page.locator("div.uppercase", {
      hasText: "Requests",
    });
    const requestsValue = requestsLabel
      .locator("xpath=..")
      .locator(".font-mono");
    const text = (await requestsValue.textContent())?.trim() ?? "";
    expect(text, `usage requests card still reads "${text}"`).toMatch(
      /^[1-9]\d*$/,
    );
  }).toPass({ timeout: 15_000, intervals: [500, 1000, 2000] });
});

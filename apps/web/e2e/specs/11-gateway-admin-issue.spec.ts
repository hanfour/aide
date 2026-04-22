import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resetDb, seedDb } from "../fixtures/seed-db";
import { signInWithSession } from "../fixtures/mock-oauth";
import { E2E_GATEWAY_BASE_URL } from "../fixtures/gateway-env";

/**
 * Part 12.2 — admin-issued one-time URL + end-to-end gateway call.
 *
 * Covers the cross-actor flow that self-issue in 12.1 can't:
 *
 *   1. super_admin (org scope) issues an API key for ANOTHER user via the
 *      admin page (`/dashboard/organizations/[id]/members/[uid]/api-keys`)
 *   2. One-time reveal URL appears in the admin dialog
 *   3. A second browser context, signed in as the target member, opens the
 *      URL and claims the raw key
 *   4. The member uses the key against the real gateway process → 200
 *   5. Re-opening the already-claimed reveal URL shows the error page
 *      (single-use CAS via `revealed_at`)
 *
 * IP-whitelist 403 coverage is NOT included here: the admin-issue UI in 4A
 * doesn't expose an ip_whitelist field (see the post-4A parking lot in
 * `.claude/plans/2026-04-21-plan-4a-parts-11-13-handoff.md`), and no tRPC
 * mutation updates the column after the fact either. Lives in whichever
 * plan ships that UI.
 */
test("admin-issued one-time URL: issue → reveal in second context → gateway round-trip → single-use enforced", async ({
  browser,
}) => {
  const orgId = randomUUID();
  const adminToken = "e2e-gw-admin-issue-" + Date.now();
  const memberToken = "e2e-gw-member-" + Date.now();

  await resetDb();
  const seed = await seedDb({
    reset: false,
    orgs: [{ id: orgId, slug: "e2e-gw-issue", name: "E2E Gateway Issue" }],
    users: [
      { email: "admin-gw-issue@e2e.test", sessionToken: adminToken },
      { email: "member-gw@e2e.test", sessionToken: memberToken },
    ],
  });
  const [admin, member] = seed.users;
  if (!admin || !member) throw new Error("admin/member not seeded");
  await seedDb({
    reset: false,
    orgMembers: [
      { orgId, userId: admin.id },
      // Target user MUST be an org member — issueForUser has a cross-tenant
      // integrity check (see apiKeys.ts ~line 214 comment block) that rejects
      // issuing for a non-member even if the caller has org-wide perm.
      { orgId, userId: member.id },
    ],
    roleAssignments: [
      // Global super_admin short-circuits every downstream perm check.
      { userId: admin.id, role: "super_admin", scopeType: "global" },
      // Member needs an explicit grant in org scope or the reveal page's
      // session probe won't recognise them as belonging anywhere — they just
      // need to be an authenticated user for revealViaToken (which uses
      // ownership rather than RBAC).
      {
        userId: member.id,
        role: "member",
        scopeType: "organization",
        scopeId: orgId,
      },
    ],
  });

  // ── Admin context: create account + issue the one-time URL ─────────────
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInWithSession(adminContext, { sessionToken: adminToken });

  await adminPage.goto(`/dashboard/organizations/${orgId}/accounts/new`);
  await adminPage.getByLabel("Name").fill("e2e-anthropic-admin-issue");
  await adminPage.getByLabel("Credentials").fill("sk-ant-fake-e2e-issue");
  await adminPage.getByRole("button", { name: /create account/i }).click();
  await expect(adminPage).toHaveURL(
    new RegExp(`/dashboard/organizations/${orgId}/accounts$`),
  );

  await adminPage.goto(
    `/dashboard/organizations/${orgId}/members/${member.id}/api-keys`,
  );
  await adminPage.getByRole("button", { name: /issue new key/i }).click();
  const issueDialog = adminPage.getByRole("dialog");
  // Dialog's input has id="adminApiKeyName"; getByLabel("Name") inside the
  // dialog locator disambiguates from the profile form's Display name field.
  await issueDialog.getByLabel("Name").fill("e2e-admin-issued-key");
  await issueDialog
    .getByRole("button", { name: /generate one-time url/i })
    .click();

  // Reveal URL lands in <code id="apiKeyRevealUrl"> once the mutation
  // settles. The admin NEVER sees the raw key itself — only the URL.
  const revealUrlCode = issueDialog.locator("#apiKeyRevealUrl");
  await expect(revealUrlCode).toBeVisible();
  const revealUrl = (await revealUrlCode.textContent())?.trim();
  expect(revealUrl, "admin dialog should show a reveal URL").toBeTruthy();
  expect(revealUrl).toMatch(/\/api-keys\/reveal\/[A-Za-z0-9_-]+$/);
  await issueDialog.getByRole("button", { name: /done/i }).click();

  // ── Member context: claim the key ──────────────────────────────────────
  // Fresh browser context = no admin cookies. Sign in as the member first so
  // the reveal page's session probe passes; otherwise it redirects to
  // /sign-in and waits for OAuth (which we don't exercise in E2E).
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await signInWithSession(memberContext, { sessionToken: memberToken });

  // The reveal URL is absolute against GATEWAY_BASE_URL. Convert to a path
  // relative to the web baseURL so Playwright keeps using the correct
  // origin — the reveal page itself lives on `apps/web`, not the gateway.
  const revealPath = new URL(revealUrl!).pathname;
  await memberPage.goto(revealPath);

  await expect(memberPage.getByText(/claim your api key/i)).toBeVisible();
  await memberPage.getByRole("button", { name: /reveal key/i }).click();

  const memberKeyCode = memberPage.locator("#apiKeyRaw");
  await expect(memberKeyCode).toBeVisible();
  const rawKey = (await memberKeyCode.textContent())?.trim();
  expect(rawKey).toMatch(/^ak_/);

  // ── Member uses the key against the gateway ────────────────────────────
  const gwResponse = await memberPage.request.post(
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
    `gateway rejected admin-issued key: ${await gwResponse.text()}`,
  ).toBe(200);
  const gwBody = (await gwResponse.json()) as {
    type: string;
    content: Array<{ text: string }>;
  };
  expect(gwBody.type).toBe("message");
  expect(gwBody.content[0]?.text).toBe("ok");

  // ── Single-use enforcement: re-open the same URL → error shell ─────────
  // CAS on `revealed_at` ran inside the first reveal call, so the second
  // attempt's revealViaToken returns NOT_FOUND and the page shows the error
  // shell. Use a fresh context to defeat any component-state caching.
  const reopenContext = await browser.newContext();
  const reopenPage = await reopenContext.newPage();
  await signInWithSession(reopenContext, { sessionToken: memberToken });
  await reopenPage.goto(revealPath);
  await reopenPage.getByRole("button", { name: /reveal key/i }).click();
  await expect(reopenPage.getByText(/can.?t be revealed/i)).toBeVisible();

  await adminContext.close();
  await memberContext.close();
  await reopenContext.close();
});

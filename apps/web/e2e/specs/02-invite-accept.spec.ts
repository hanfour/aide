import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resetDb, seedDb } from "../fixtures/seed-db";
import { signInWithSession, signOut } from "../fixtures/mock-oauth";

test("org_admin creates an invite, invitee accepts and lands in the org", async ({
  context,
  page,
}) => {
  const orgId = randomUUID();
  const adminToken = "e2e-invite-admin-" + Date.now();
  await resetDb();
  const seed = await seedDb({
    reset: false,
    orgs: [{ id: orgId, slug: "e2e-inv", name: "E2E Invite Org" }],
    users: [
      { email: "admin-invite@e2e.test", sessionToken: adminToken },
    ],
    orgMembers: [],
  });
  const admin = seed.users[0];
  if (!admin) throw new Error("admin not seeded");
  // Grant admin role via a second seed call so we have the user id.
  await seedDb({
    reset: false,
    orgMembers: [{ orgId, userId: admin.id }],
    roleAssignments: [
      {
        userId: admin.id,
        role: "org_admin",
        scopeType: "organization",
        scopeId: orgId,
      },
    ],
  });

  await signInWithSession(context, { sessionToken: adminToken });

  // Create an invite via the admin UI.
  await page.goto(`/dashboard/organizations/${orgId}/invites`);
  await page.getByRole("button", { name: /new invite/i }).click();
  await page.getByLabel(/email/i).fill("invitee@e2e.test");
  await page.getByRole("button", { name: /create|send/i }).click();

  // Capture the generated invite URL from the success state.
  const inviteLink = await page
    .getByText(/\/invite\//)
    .first()
    .innerText();
  const match = inviteLink.match(/\/invite\/([^\s"'<>]+)/);
  if (!match?.[1]) throw new Error(`could not parse invite link: ${inviteLink}`);
  const inviteToken = match[1];

  // The invitee arrives with their own session — simulate that by seeding a
  // user + session bound to the invited email.
  await signOut(context);
  const inviteeSessionToken = "e2e-invitee-" + Date.now();
  await seedDb({
    reset: false,
    users: [
      { email: "invitee@e2e.test", sessionToken: inviteeSessionToken },
    ],
  });
  await signInWithSession(context, { sessionToken: inviteeSessionToken });

  await page.goto(`/invite/${inviteToken}`);
  // Acceptance redirects to the org detail or dashboard once the membership
  // row is created. Either destination proves acceptance worked.
  await expect(page).toHaveURL(/\/dashboard/);
});

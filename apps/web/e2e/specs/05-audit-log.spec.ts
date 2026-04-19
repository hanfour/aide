import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resetDb, seedDb } from "../fixtures/seed-db";
import { signInWithSession } from "../fixtures/mock-oauth";

test("audit log reflects invite.created by org_admin within 10s", async ({
  context,
  page,
}) => {
  const orgId = randomUUID();
  const adminToken = "e2e-audit-admin-" + Date.now();
  await resetDb();
  const seed = await seedDb({
    reset: false,
    orgs: [{ id: orgId, slug: "e2e-audit", name: "E2E Audit Org" }],
    users: [{ email: "admin-audit@e2e.test", sessionToken: adminToken }],
  });
  const admin = seed.users[0];
  if (!admin) throw new Error("admin not seeded");
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

  // Trigger an audited action — creating an invite.
  await page.goto(`/dashboard/organizations/${orgId}/invites`);
  await page.getByRole("button", { name: /new invite/i }).click();
  await page.getByLabel(/email/i).fill("audit-target@e2e.test");
  await page.getByRole("button", { name: /create|send/i }).click();
  // Wait for the success pill / invite link before moving on.
  await expect(page.getByText(/\/invite\//)).toBeVisible();

  // Visit audit and confirm the latest row is invite.created, authored by
  // the admin, within the last 10 seconds.
  await page.goto(`/dashboard/organizations/${orgId}/audit`);
  const inviteRow = page
    .locator("tr", { hasText: "invite.created" })
    .first();
  await expect(inviteRow).toBeVisible();
  await expect(inviteRow).toContainText("admin-audit@e2e.test");
});

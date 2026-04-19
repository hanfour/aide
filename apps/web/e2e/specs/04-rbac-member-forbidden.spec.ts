import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resetDb, seedDb } from "../fixtures/seed-db";
import { signInWithSession } from "../fixtures/mock-oauth";

test("member role cannot create teams; both UI and API refuse", async ({
  context,
  page,
  request,
}) => {
  const orgId = randomUUID();
  const memberToken = "e2e-rbac-member-" + Date.now();
  await resetDb();
  const seed = await seedDb({
    reset: false,
    orgs: [{ id: orgId, slug: "e2e-rbac", name: "E2E RBAC Org" }],
    users: [{ email: "member@e2e.test", sessionToken: memberToken }],
  });
  const member = seed.users[0];
  if (!member) throw new Error("member not seeded");
  await seedDb({
    reset: false,
    orgMembers: [{ orgId, userId: member.id }],
    roleAssignments: [
      {
        userId: member.id,
        role: "member",
        scopeType: "organization",
        scopeId: orgId,
      },
    ],
  });
  await signInWithSession(context, { sessionToken: memberToken });

  // UI guard: the "New Team" button should not render for a plain member.
  await page.goto(`/dashboard/organizations/${orgId}/teams`);
  await expect(page.getByRole("button", { name: /new team/i })).toHaveCount(0);

  // API guard: hitting the mutation directly returns FORBIDDEN.
  const cookies = await context.cookies();
  const sessionCookie = cookies.find((c) => c.name === "authjs.session-token");
  if (!sessionCookie) throw new Error("session cookie missing");
  const cookieHeader = `${sessionCookie.name}=${sessionCookie.value}`;

  const res = await request.post("/trpc/teams.create?batch=1", {
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader,
    },
    data: JSON.stringify({
      "0": {
        json: {
          orgId,
          slug: "members-cant-do-this",
          name: "Members can't create this",
        },
      },
    }),
  });

  // tRPC returns 200 with an error payload in batch mode; either a 2xx with
  // `error.data.code === 'FORBIDDEN'` or a 4xx both count as rejected.
  if (res.status() >= 200 && res.status() < 300) {
    const body = await res.json();
    const code =
      body?.[0]?.error?.data?.code ?? body?.error?.data?.code ?? body?.error?.code;
    expect(code).toBe("FORBIDDEN");
  } else {
    expect(res.status()).toBeGreaterThanOrEqual(400);
  }
});

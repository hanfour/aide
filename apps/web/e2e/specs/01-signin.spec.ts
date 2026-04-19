import { test, expect } from "@playwright/test";
import { resetDb, seedDb } from "../fixtures/seed-db";
import {
  signInWithSession,
  signOut,
  SESSION_COOKIE_NAME,
} from "../fixtures/mock-oauth";

test.describe("sign-in", () => {
  test("authenticated session lands on the dashboard; sign-out clears it", async ({
    context,
    page,
  }) => {
    await resetDb();
    const sessionToken = "e2e-signin-" + Date.now();
    const seed = await seedDb({
      reset: false,
      users: [
        {
          email: "admin@e2e.test",
          name: "E2E Admin",
          sessionToken,
        },
      ],
      roleAssignments: [],
    });
    const user = seed.users[0];
    expect(user?.sessionToken).toBe(sessionToken);

    await signInWithSession(context, { sessionToken });

    await page.goto("/dashboard");
    // Dashboard greets the user by the local part of their email.
    await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
    await expect(page.getByText("admin", { exact: false })).toBeVisible();

    // Sign out by clearing the session cookie and re-visiting /dashboard.
    // A real sign-out flow also hits /api/auth/signout; either path ends at
    // /sign-in because the cookie is no longer valid.
    await signOut(context);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/sign-in/);

    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === SESSION_COOKIE_NAME)).toBeUndefined();
  });

  test("unauthenticated /dashboard request redirects to /sign-in", async ({
    page,
  }) => {
    await resetDb();
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/sign-in/);
  });
});

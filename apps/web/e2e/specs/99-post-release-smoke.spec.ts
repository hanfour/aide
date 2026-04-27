import { test, expect } from "@playwright/test";

/**
 * Plan 4C Part 11 — post-release smoke against the canary environment.
 *
 * This spec is intentionally separate from the rest of the e2e suite: it does
 * NOT spin up local servers, does NOT seed a fresh DB, and is invoked by the
 * `post-release-smoke` workflow with `CANARY_*` secrets pointing at the live
 * canary tenant. Skips automatically when those vars are unset so the file
 * remains harmless during local `pnpm test:e2e` runs.
 *
 * Coverage:
 *   - cost dashboard renders (proves Plan 4C UI shipped)
 *   - status page renders + cost-summary widget visible (proves cross-page
 *     wiring stayed intact through the build pipeline)
 */

const baseUrl = process.env.CANARY_BASE_URL;
const cookie = process.env.CANARY_SESSION_COOKIE;
const orgId = process.env.CANARY_ORG_ID;

test.describe("post-release smoke (canary org)", () => {
  test.beforeEach(async ({ context }) => {
    if (!baseUrl || !cookie || !orgId) {
      test.skip(
        true,
        "CANARY_BASE_URL / CANARY_SESSION_COOKIE / CANARY_ORG_ID not set — skipping",
      );
      return;
    }

    // Cookie format expected: `next-auth.session-token=<value>` (raw header
    // form). Split on the first `=` so values containing `=` (e.g. base64-
    // padded session tokens) survive intact.
    const eqIdx = cookie.indexOf("=");
    if (eqIdx === -1) {
      throw new Error(
        "CANARY_SESSION_COOKIE must be in `name=value` header format",
      );
    }
    const name = cookie.slice(0, eqIdx);
    const value = cookie.slice(eqIdx + 1);
    const url = new URL(baseUrl);

    await context.addCookies([
      {
        name,
        value,
        domain: url.hostname,
        path: "/",
        secure: url.protocol === "https:",
        httpOnly: true,
      },
    ]);
  });

  test("admin loads evaluator cost dashboard", async ({ page }) => {
    await page.goto(`${baseUrl}/dashboard/organizations/${orgId}/evaluator/costs`);
    await expect(
      page.getByRole("heading", { name: /LLM Cost Dashboard/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("admin loads evaluator status page (cost widget visible)", async ({
    page,
  }) => {
    await page.goto(
      `${baseUrl}/dashboard/organizations/${orgId}/evaluator/status`,
    );
    await expect(
      page.getByRole("heading", { name: /Evaluator Status/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/This month'?s LLM spend/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});

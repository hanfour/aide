import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3000);
const API_PORT = Number(process.env.E2E_API_PORT ?? 3001);
const isCI = !!process.env.CI;

// Must match what the API is configured with via ENABLE_TEST_SEED + TEST_SEED_TOKEN.
// Fixtures read this from process.env too.
const SEED_TOKEN =
  process.env.TEST_SEED_TOKEN ?? "e2e-test-token-0000000000000000000000";

export default defineConfig({
  testDir: "./specs",
  outputDir: "./.playwright",
  // Specs share a single database, so run serially to avoid seed collisions.
  // Parallelising would require per-worker database isolation — deferred.
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,
  reporter: isCI
    ? [["html", { outputFolder: "playwright-report", open: "never" }], ["github"]]
    : [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // In CI the workflow starts api+web itself before invoking playwright, so we
  // skip webServer. Locally, auto-boot a dev stack for convenience.
  webServer: isCI
    ? undefined
    : [
        {
          command: `pnpm --filter @aide/api dev`,
          url: `http://localhost:${API_PORT}/health`,
          timeout: 60_000,
          reuseExistingServer: true,
          env: {
            NODE_ENV: "test",
            ENABLE_TEST_SEED: "true",
            TEST_SEED_TOKEN: SEED_TOKEN,
            PORT: String(API_PORT),
          },
        },
        {
          command: `pnpm --filter @aide/web dev`,
          url: `http://localhost:${WEB_PORT}/sign-in`,
          timeout: 120_000,
          reuseExistingServer: true,
          env: {
            NODE_ENV: "development",
            API_INTERNAL_URL: `http://localhost:${API_PORT}`,
            PORT: String(WEB_PORT),
          },
        },
      ],
});

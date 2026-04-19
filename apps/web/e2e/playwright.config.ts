import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3000);
const API_PORT = Number(process.env.E2E_API_PORT ?? 3001);
const isCI = !!process.env.CI;

// Must match what the API is configured with via ENABLE_TEST_SEED + TEST_SEED_TOKEN.
// Fixtures read this from process.env too.
const SEED_TOKEN =
  process.env.TEST_SEED_TOKEN ?? "e2e-test-token-0000000000000000000000";

// parseServerEnv() runs at api + web startup and rejects the process if any
// required var is missing. Playwright's webServer.env *replaces* process.env
// rather than merging it, so we have to forward the whole server schema.
//
// Defaults below are E2E-safe: OAuth creds are never actually called (we
// mock sessions via cookie injection), AUTH_SECRET just needs ≥32 bytes, and
// BOOTSTRAP_* values only feed the "first sign-in" flow which specs don't
// currently exercise. Only DATABASE_URL deserves a real value — default
// matches the dev compose creds so zero-config local runs just work.
const appEnvDefaults: Record<string, string> = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgresql://aide:aide_dev@localhost:5432/aide",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "0".repeat(48),
  NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? `http://localhost:${WEB_PORT}`,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "e2e",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "e2e",
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? "e2e",
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? "e2e",
  BOOTSTRAP_SUPER_ADMIN_EMAIL:
    process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL ?? "admin@e2e.test",
  BOOTSTRAP_DEFAULT_ORG_SLUG:
    process.env.BOOTSTRAP_DEFAULT_ORG_SLUG ?? "demo",
  BOOTSTRAP_DEFAULT_ORG_NAME:
    process.env.BOOTSTRAP_DEFAULT_ORG_NAME ?? "Demo",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
};

// Sanitised passthrough of the parent environment (PATH, HOME, pnpm cache,
// etc. are needed for the child process to even spawn correctly). Filter
// undefined values because Playwright rejects those.
const inheritedEnv: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
);

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
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...inheritedEnv,
            ...appEnvDefaults,
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
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...inheritedEnv,
            ...appEnvDefaults,
            NODE_ENV: "development",
            API_INTERNAL_URL: `http://localhost:${API_PORT}`,
            PORT: String(WEB_PORT),
          },
        },
      ],
});

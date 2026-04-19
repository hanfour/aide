import { defineConfig } from "vitest/config";

// Playwright's @playwright/test exports `test` with a different signature
// than vitest's. Without excluding e2e/ explicitly vitest tries to parse
// those specs and crashes. Playwright owns e2e runs via its own config.
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.next/**", "e2e/**"],
    passWithNoTests: true,
  },
});

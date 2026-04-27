import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Playwright's @playwright/test exports `test` with a different signature
// than vitest's. Without excluding e2e/ explicitly vitest tries to parse
// those specs and crashes. Playwright owns e2e runs via its own config.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "tests/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: ["**/node_modules/**", "**/.next/**", "e2e/**"],
    css: false,
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});

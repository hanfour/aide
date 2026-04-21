import { describe, it, expect } from "vitest";
import { appRouter } from "../../../src/trpc/router.js";

// Regression guard for Plan 4A Part 8 Task 8.4: ensures every router
// expected to be wired into the global appRouter is in fact registered.
// If a router is accidentally removed from `router.ts`, the corresponding
// caller path would silently 404 at runtime; this test fails the build
// instead. We assert against `_def.record` rather than calling procedures
// so the check stays cheap and side-effect-free.
describe("appRouter registration", () => {
  const expectedNamespaces = [
    "me",
    "organizations",
    "departments",
    "teams",
    "users",
    "invites",
    "roles",
    "auditLogs",
    "accounts",
    "apiKeys",
    "usage",
  ] as const;

  for (const ns of expectedNamespaces) {
    it(`exposes the "${ns}" router`, () => {
      expect(appRouter._def.record[ns]).toBeDefined();
    });
  }
});

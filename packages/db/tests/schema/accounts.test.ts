import { describe, it, expect } from "vitest";
import { upstreamAccounts } from "../../src/schema/accounts";

describe("upstream_accounts schema", () => {
  it("exports table with required columns", () => {
    expect(upstreamAccounts).toBeDefined();
    const cols = Object.keys(upstreamAccounts);
    for (const c of [
      "id",
      "orgId",
      "teamId",
      "name",
      "platform",
      "type",
      "schedulable",
      "priority",
      "concurrency",
      "rateMultiplier",
      "rateLimitedAt",
      "rateLimitResetAt",
      "overloadUntil",
      "tempUnschedulableUntil",
      "tempUnschedulableReason",
      "lastUsedAt",
      "oauthRefreshFailCount",
      "oauthRefreshLastError",
      "oauthRefreshLastRunAt",
      "expiresAt",
      "autoPauseOnExpired",
      "status",
      "errorMessage",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]) {
      expect(cols).toContain(c);
    }
  });
});

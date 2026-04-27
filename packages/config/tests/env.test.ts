import { describe, it, expect } from "vitest";
import { parseServerEnv } from "../src/env";

describe("parseServerEnv", () => {
  const valid = {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    AUTH_SECRET: "a".repeat(32),
    NEXTAUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "g-id",
    GOOGLE_CLIENT_SECRET: "g-secret",
    GITHUB_CLIENT_ID: "gh-id",
    GITHUB_CLIENT_SECRET: "gh-secret",
    BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@example.com",
    BOOTSTRAP_DEFAULT_ORG_SLUG: "demo",
    BOOTSTRAP_DEFAULT_ORG_NAME: "Demo Org",
  };

  it("parses a complete env", () => {
    const env = parseServerEnv(valid);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.ENABLE_SWAGGER).toBe(false);
  });

  it('ENABLE_FACET_EXTRACTION defaults to false and accepts string "true"', () => {
    const off = parseServerEnv(valid);
    expect(off.ENABLE_FACET_EXTRACTION).toBe(false);

    const on = parseServerEnv({ ...valid, ENABLE_FACET_EXTRACTION: "true" });
    expect(on.ENABLE_FACET_EXTRACTION).toBe(true);
  });

  it("rejects AUTH_SECRET shorter than 32 chars", () => {
    expect(() => parseServerEnv({ ...valid, AUTH_SECRET: "short" })).toThrow();
  });

  it("rejects invalid DATABASE_URL", () => {
    expect(() =>
      parseServerEnv({ ...valid, DATABASE_URL: "not-a-url" }),
    ).toThrow();
  });

  it("rejects missing BOOTSTRAP_SUPER_ADMIN_EMAIL", () => {
    const { BOOTSTRAP_SUPER_ADMIN_EMAIL: _, ...rest } = valid;
    expect(() => parseServerEnv(rest)).toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";
import { parseServerEnv, type ServerEnv } from "@aide/config";

const validBase = {
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
} as const;

function makeEnv(overrides: Record<string, string> = {}): ServerEnv {
  return parseServerEnv({ ...validBase, ...overrides });
}

describe("gateway server", () => {
  it("responds 200 on /health", async () => {
    const app = await buildServer({
      env: makeEnv({
        ENABLE_GATEWAY: "true",
        GATEWAY_BASE_URL: "http://localhost:3002",
        REDIS_URL: "redis://localhost:6379",
        CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
        API_KEY_HASH_PEPPER: "b".repeat(64),
      }),
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns {status:"disabled"} when ENABLE_GATEWAY=false', async () => {
    const app = await buildServer({ env: makeEnv() });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({ status: "disabled" });
    await app.close();
  });

  it("fail-fast: parseServerEnv throws when ENABLE_GATEWAY=true but required gateway vars are missing", () => {
    expect(() =>
      parseServerEnv({ ...validBase, ENABLE_GATEWAY: "true" }),
    ).toThrow();
  });
});

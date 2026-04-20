import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { organizations, upstreamAccounts, credentialVault } from "@aide/db";
import { encryptCredential } from "@aide/gateway-core";
import { OAuthRefreshCron } from "../../src/workers/oauthRefreshCron.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@aide/db/package.json")),
  "drizzle",
);

// ── Postgres testcontainer ───────────────────────────────────────────────────

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let orgId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({
      slug: "oauth-cron-test-org",
      name: "OAuth Cron Test Org",
    })
    .returning();
  orgId = org!.id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

// ── Fake token HTTP server ───────────────────────────────────────────────────

let tokenServer: Server;
let tokenBaseUrl: string;
let tokenCallCount: number;
let lastTokenRequest: { headers: IncomingMessage["headers"]; body: string } | null;
let nextTokenResponse: { status: number; body: string };

beforeAll(async () => {
  nextTokenResponse = {
    status: 200,
    body: JSON.stringify({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
    }),
  };
  tokenCallCount = 0;
  lastTokenRequest = null;

  tokenServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      tokenCallCount++;
      lastTokenRequest = { headers: req.headers, body };
      res.statusCode = nextTokenResponse.status;
      res.setHeader("content-type", "application/json");
      res.end(nextTokenResponse.body);
    });
  });
  await new Promise<void>((r) => tokenServer.listen(0, "127.0.0.1", r));
  const addr = tokenServer.address() as AddressInfo;
  tokenBaseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => tokenServer.close(() => r())));

// ── Per-test cleanup ─────────────────────────────────────────────────────────

beforeEach(async () => {
  tokenCallCount = 0;
  lastTokenRequest = null;
  nextTokenResponse = {
    status: 200,
    body: JSON.stringify({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
    }),
  };
  await db.delete(credentialVault);
  await db.delete(upstreamAccounts);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const MASTER_KEY = "b".repeat(64); // 32-byte hex key for tests

function makeRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

function makeCron(
  redis: Redis,
  overrides: Partial<{ now: () => number; jitter: () => number }> = {},
): OAuthRefreshCron {
  return new OAuthRefreshCron(db as never, redis, {
    masterKeyHex: MASTER_KEY,
    maxFail: 3,
    tokenUrl: tokenBaseUrl,
    clientId: "test-client-id",
    ...overrides,
  });
}

async function seedAccount(
  overrides: Partial<{
    failCount: number;
    status: string;
    schedulable: boolean;
    lastRunAt: Date;
    type: string;
  }> = {},
) {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "test-oauth-account",
      platform: "anthropic",
      type: overrides.type ?? "oauth",
      schedulable: overrides.schedulable ?? true,
      status: overrides.status ?? "active",
      oauthRefreshFailCount: overrides.failCount ?? 0,
      oauthRefreshLastRunAt: overrides.lastRunAt ?? null,
    })
    .returning();
  return acct!;
}

async function seedVault(
  accountId: string,
  expiresAt: Date,
  tokens: { accessToken: string; refreshToken: string } = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
  },
) {
  const plaintext = JSON.stringify({
    type: "oauth",
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_at: expiresAt.toISOString(),
  });
  const sealed = encryptCredential({
    masterKeyHex: MASTER_KEY,
    accountId,
    plaintext,
  });
  await db.insert(credentialVault).values({
    accountId,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    authTag: sealed.authTag,
    oauthExpiresAt: expiresAt,
  });
}

/** Returns a Date that is `minutes` minutes from now (negative = past). */
function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("OAuthRefreshCron.runOnce", () => {
  it("1. empty candidate set → no work done", async () => {
    const cron = makeCron(makeRedis());
    const result = await cron.runOnce();

    expect(result).toEqual({ refreshed: 0, skipped: 0, failed: 0 });
    expect(tokenCallCount).toBe(0);
  });

  it("2. one candidate refreshed successfully — vault rotated, fail_count reset", async () => {
    // Credential expires in 5 minutes → inside cron's 10-minute lead window
    const expiresAt = minutesFromNow(5);
    const acct = await seedAccount({ failCount: 2 });
    await seedVault(acct.id, expiresAt);

    const cron = makeCron(makeRedis());
    const result = await cron.runOnce();

    expect(result).toEqual({ refreshed: 1, skipped: 0, failed: 0 });
    expect(tokenCallCount).toBe(1);

    // Vault should have rotated_at set
    const [vaultRow] = await db
      .select({
        oauthExpiresAt: credentialVault.oauthExpiresAt,
        rotatedAt: credentialVault.rotatedAt,
      })
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));
    expect(vaultRow!.rotatedAt).not.toBeNull();
    expect(vaultRow!.oauthExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    // Account fail_count should be reset to 0
    const [acctRow] = await db
      .select({ failCount: upstreamAccounts.oauthRefreshFailCount })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));
    expect(acctRow!.failCount).toBe(0);
  });

  it("3. backoff applied: fail_count=2, last_run_at recent → skipped", async () => {
    // fail_count=2 → backoff = 2^2 * 60s = 240s. last_run_at = 30s ago → still in backoff window.
    const lastRunAt = new Date(Date.now() - 30 * 1000);
    const expiresAt = minutesFromNow(5);
    const acct = await seedAccount({ failCount: 2, lastRunAt });
    await seedVault(acct.id, expiresAt);

    const cron = makeCron(makeRedis());
    const result = await cron.runOnce();

    expect(result).toEqual({ refreshed: 0, skipped: 1, failed: 0 });
    expect(tokenCallCount).toBe(0);
  });

  it("4. backoff cleared: fail_count=2, last_run_at long ago → refreshed", async () => {
    // fail_count=2 → backoff = 240s. last_run_at = 300s ago → backoff elapsed → proceed.
    const lastRunAt = new Date(Date.now() - 300 * 1000);
    const expiresAt = minutesFromNow(5);
    const acct = await seedAccount({ failCount: 2, lastRunAt });
    await seedVault(acct.id, expiresAt);

    const cron = makeCron(makeRedis());
    const result = await cron.runOnce();

    expect(result).toEqual({ refreshed: 1, skipped: 0, failed: 0 });
    expect(tokenCallCount).toBe(1);
  });

  it("5. lock contention: pre-set redis lock → skipped without calling token server", async () => {
    const expiresAt = minutesFromNow(5);
    const acct = await seedAccount();
    await seedVault(acct.id, expiresAt);

    const redis = makeRedis();
    // Pre-acquire the lock as if another instance holds it
    await redis.set(`oauth-refresh:${acct.id}`, "1", "EX", 30, "NX");

    const cron = makeCron(redis);
    const result = await cron.runOnce();

    expect(result).toEqual({ refreshed: 0, skipped: 1, failed: 0 });
    expect(tokenCallCount).toBe(0);
  });

  it("6. token endpoint failure → failed:1, fail_count incremented", async () => {
    nextTokenResponse = {
      status: 500,
      body: JSON.stringify({ error: "server_error" }),
    };

    const expiresAt = minutesFromNow(5);
    const acct = await seedAccount({ failCount: 0 });
    await seedVault(acct.id, expiresAt);

    const cron = makeCron(makeRedis());
    const result = await cron.runOnce();

    expect(result).toEqual({ refreshed: 0, skipped: 0, failed: 1 });
    expect(tokenCallCount).toBe(1);

    const [acctRow] = await db
      .select({
        failCount: upstreamAccounts.oauthRefreshFailCount,
        status: upstreamAccounts.status,
      })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));
    expect(acctRow!.failCount).toBe(1);
    expect(acctRow!.status).toBe("active"); // still under maxFail threshold
  });

  it("7. hits maxFail threshold → status='error', schedulable=false", async () => {
    nextTokenResponse = {
      status: 500,
      body: JSON.stringify({ error: "server_error" }),
    };

    // fail_count=2, maxFail=3 → one more failure tips it over
    const expiresAt = minutesFromNow(5);
    const acct = await seedAccount({ failCount: 2 });
    await seedVault(acct.id, expiresAt);

    const cron = new OAuthRefreshCron(db as never, makeRedis(), {
      masterKeyHex: MASTER_KEY,
      maxFail: 3,
      tokenUrl: tokenBaseUrl,
      clientId: "test-client-id",
    });
    const result = await cron.runOnce();

    expect(result).toEqual({ refreshed: 0, skipped: 0, failed: 1 });

    const [acctRow] = await db
      .select({
        failCount: upstreamAccounts.oauthRefreshFailCount,
        status: upstreamAccounts.status,
        schedulable: upstreamAccounts.schedulable,
      })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));
    expect(acctRow!.failCount).toBe(3);
    expect(acctRow!.status).toBe("error");
    expect(acctRow!.schedulable).toBe(false);
  });

  it("8. multiple candidates: 2 refresh, 1 backoff-skipped → counts correct", async () => {
    const expiresAt = minutesFromNow(5);

    // Account A: fresh, should refresh
    const acctA = await seedAccount();
    await seedVault(acctA.id, expiresAt, {
      accessToken: "a-access",
      refreshToken: "a-refresh",
    });

    // Account B: fresh, should refresh
    const acctB = await seedAccount();
    await seedVault(acctB.id, expiresAt, {
      accessToken: "b-access",
      refreshToken: "b-refresh",
    });

    // Account C: fail_count=1 with recent last_run_at → backoff (2^1*60s=120s, run 30s ago → skip)
    const lastRunAt = new Date(Date.now() - 30 * 1000);
    const acctC = await seedAccount({ failCount: 1, lastRunAt });
    await seedVault(acctC.id, expiresAt, {
      accessToken: "c-access",
      refreshToken: "c-refresh",
    });

    const cron = makeCron(makeRedis());
    const result = await cron.runOnce();

    expect(result).toEqual({ refreshed: 2, skipped: 1, failed: 0 });
    expect(tokenCallCount).toBe(2);
  });
});

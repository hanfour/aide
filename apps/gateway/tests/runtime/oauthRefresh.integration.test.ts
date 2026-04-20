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
import { encryptCredential, decryptCredential } from "@aide/gateway-core";
import {
  maybeRefreshOAuth,
  OAuthRefreshError,
} from "../../src/runtime/oauthRefresh.js";
import type { ResolvedCredential } from "../../src/runtime/resolveCredential.js";

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
    .values({ slug: "oauth-refresh-test-org", name: "OAuth Refresh Test Org" })
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
let lastTokenRequest: { headers: IncomingMessage["headers"]; body: string } | null = null;
let nextTokenResponse: { status: number; body: string };

beforeAll(async () => {
  nextTokenResponse = { status: 200, body: "{}" };
  tokenServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
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

const MASTER_KEY = "a".repeat(64); // 32-byte hex key for tests

function makeRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

async function seedAccount(overrides: Partial<{
  failCount: number;
  status: string;
  schedulable: boolean;
}> = {}) {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({
      orgId,
      name: "test-oauth-account",
      platform: "anthropic",
      type: "oauth",
      schedulable: overrides.schedulable ?? true,
      status: overrides.status ?? "active",
      oauthRefreshFailCount: overrides.failCount ?? 0,
    })
    .returning();
  return acct!;
}

async function seedVault(
  accountId: string,
  credential: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  },
) {
  const plaintext = JSON.stringify({
    type: "oauth",
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    expires_at: credential.expiresAt.toISOString(),
  });
  const sealed = encryptCredential({ masterKeyHex: MASTER_KEY, accountId, plaintext });
  await db
    .insert(credentialVault)
    .values({
      accountId,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      authTag: sealed.authTag,
      oauthExpiresAt: credential.expiresAt,
    });
}

function staleExpiresAt(now: number = Date.now()): Date {
  // expired 10 minutes ago
  return new Date(now - 10 * 60 * 1000);
}

function freshExpiresAt(now: number = Date.now()): Date {
  // expires in 30 minutes
  return new Date(now + 30 * 60 * 1000);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("maybeRefreshOAuth", () => {
  it("1. fast path: not yet expiring → returns current unchanged; no token request, no DB update", async () => {
    const acct = await seedAccount();
    const expiresAt = freshExpiresAt();
    await seedVault(acct.id, {
      accessToken: "original-access",
      refreshToken: "original-refresh",
      expiresAt,
    });

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "original-access",
      refreshToken: "original-refresh",
      expiresAt,
    };

    const result = await maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
      masterKeyHex: MASTER_KEY,
      leadMinutes: 10,
      maxFail: 3,
      tokenUrl: tokenBaseUrl,
    });

    expect(result).toBe(currentCredential); // same object reference
    expect(lastTokenRequest).toBeNull();

    const [vaultRow] = await db
      .select({ rotatedAt: credentialVault.rotatedAt })
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));
    expect(vaultRow!.rotatedAt).toBeNull();
  });

  it("2. winner: lock acquired, refresh succeeds, vault updated, account fail_count reset", async () => {
    const acct = await seedAccount({ failCount: 2 });
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    });

    nextTokenResponse = {
      status: 200,
      body: JSON.stringify({
        access_token: "fresh-access-token",
        refresh_token: "fresh-refresh-token",
        expires_in: 3600,
      }),
    };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    };

    const result = await maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
      masterKeyHex: MASTER_KEY,
      leadMinutes: 10,
      maxFail: 5,
      tokenUrl: tokenBaseUrl,
    });

    expect(result.type).toBe("oauth");
    expect(result.accessToken).toBe("fresh-access-token");
    expect(result.refreshToken).toBe("fresh-refresh-token");
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3500 * 1000);

    const [vaultRow] = await db
      .select({ oauthExpiresAt: credentialVault.oauthExpiresAt, rotatedAt: credentialVault.rotatedAt })
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));
    expect(vaultRow!.oauthExpiresAt).not.toBeNull();
    expect(vaultRow!.oauthExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 3500 * 1000);
    expect(vaultRow!.rotatedAt).not.toBeNull();

    const [acctRow] = await db
      .select({ failCount: upstreamAccounts.oauthRefreshFailCount, lastError: upstreamAccounts.oauthRefreshLastError })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));
    expect(acctRow!.failCount).toBe(0);
    expect(acctRow!.lastError).toBeNull();
  });

  it("3. winner: token endpoint returns 400 → recordFailure increments fail_count + last_error set; throws OAuthRefreshError; lock released", async () => {
    const acct = await seedAccount({ failCount: 0 });
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    });

    nextTokenResponse = { status: 400, body: JSON.stringify({ error: "invalid_grant" }) };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    };

    await expect(
      maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
      }),
    ).rejects.toBeInstanceOf(OAuthRefreshError);

    const [acctRow] = await db
      .select({
        failCount: upstreamAccounts.oauthRefreshFailCount,
        lastError: upstreamAccounts.oauthRefreshLastError,
        status: upstreamAccounts.status,
      })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));
    expect(acctRow!.failCount).toBe(1);
    expect(acctRow!.lastError).toBeTruthy();
    expect(acctRow!.status).toBe("active"); // under maxFail threshold

    // Lock must be released
    const lockKey = `oauth-refresh:${acct.id}`;
    const exists = await redis.exists(lockKey);
    expect(exists).toBe(0);
  });

  it("4. 3 consecutive failures → fail_count=3 >= maxFail=3 → account marked status='error', schedulable=false", async () => {
    const acct = await seedAccount({ failCount: 2 });
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    });

    nextTokenResponse = { status: 500, body: JSON.stringify({ error: "server_error" }) };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    };

    await expect(
      maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
      }),
    ).rejects.toBeInstanceOf(OAuthRefreshError);

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

  it("5. winner: token endpoint returns malformed JSON → OAuthRefreshError + recordFailure", async () => {
    const acct = await seedAccount({ failCount: 0 });
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    });

    nextTokenResponse = { status: 200, body: "not-valid-json{{" };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    };

    await expect(
      maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
      }),
    ).rejects.toBeInstanceOf(OAuthRefreshError);

    const [acctRow] = await db
      .select({ failCount: upstreamAccounts.oauthRefreshFailCount })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, acct.id));
    expect(acctRow!.failCount).toBe(1);
  });

  it("6. loser: lock held, winner releases after 500ms, loser re-reads vault and returns refreshed credential", async () => {
    const acct = await seedAccount();
    const staleExpiry = staleExpiresAt();
    const freshExpiry = freshExpiresAt();

    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: staleExpiry,
    });

    const redis = makeRedis();
    const lockKey = `oauth-refresh:${acct.id}`;

    // Pre-set the lock so loser can't acquire it
    await redis.set(lockKey, "1", "EX", 30, "NX");

    // Schedule: after 500ms, update vault with fresh credential and release lock
    const refreshDelay = setTimeout(async () => {
      // Update vault with fresh credential
      const plaintext = JSON.stringify({
        type: "oauth",
        access_token: "winner-fresh-access",
        refresh_token: "winner-fresh-refresh",
        expires_at: freshExpiry.toISOString(),
      });
      const sealed = encryptCredential({ masterKeyHex: MASTER_KEY, accountId: acct.id, plaintext });
      await db
        .update(credentialVault)
        .set({
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
          oauthExpiresAt: freshExpiry,
          rotatedAt: new Date(),
        })
        .where(eq(credentialVault.accountId, acct.id));
      // Release lock
      await redis.del(lockKey);
    }, 500);

    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: staleExpiry,
    };

    const result = await maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
      masterKeyHex: MASTER_KEY,
      leadMinutes: 10,
      maxFail: 3,
      tokenUrl: tokenBaseUrl,
    });

    clearTimeout(refreshDelay);

    // Loser did NOT call token server
    expect(lastTokenRequest).toBeNull();
    expect(result.accessToken).toBe("winner-fresh-access");
    expect(result.refreshToken).toBe("winner-fresh-refresh");
  });

  it("7. loser: lock auto-expires but vault NOT updated → throws OAuthRefreshError 'still expired'", async () => {
    const acct = await seedAccount();
    const staleExpiry = staleExpiresAt();

    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: staleExpiry,
    });

    const redis = makeRedis();
    const lockKey = `oauth-refresh:${acct.id}`;

    // Pre-set lock with short TTL so it expires quickly
    await redis.set(lockKey, "1", "EX", 1, "NX");

    // Mock fast expiry: use a fast sleep and short poll max
    let pollCount = 0;
    const fastSleep = async (_ms: number) => {
      pollCount++;
      // After first poll, artificially expire the lock
      if (pollCount >= 1) {
        await redis.del(lockKey);
      }
    };

    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: staleExpiry,
    };

    await expect(
      maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
        sleep: fastSleep,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(OAuthRefreshError);
      expect((err as OAuthRefreshError).message).toMatch(/still expired/);
      return true;
    });
  });

  it("8. persisted credential is decryptable end-to-end", async () => {
    const acct = await seedAccount();
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "original-access",
      refreshToken: "original-refresh",
      expiresAt,
    });

    nextTokenResponse = {
      status: 200,
      body: JSON.stringify({
        access_token: "e2e-access-token",
        refresh_token: "e2e-refresh-token",
        expires_in: 7200,
      }),
    };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "original-access",
      refreshToken: "original-refresh",
      expiresAt,
    };

    await maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
      masterKeyHex: MASTER_KEY,
      leadMinutes: 10,
      maxFail: 3,
      tokenUrl: tokenBaseUrl,
    });

    // Re-read vault raw and decrypt
    const [vaultRow] = await db
      .select({
        nonce: credentialVault.nonce,
        ciphertext: credentialVault.ciphertext,
        authTag: credentialVault.authTag,
      })
      .from(credentialVault)
      .where(eq(credentialVault.accountId, acct.id));

    const plaintext = decryptCredential({
      masterKeyHex: MASTER_KEY,
      accountId: acct.id,
      sealed: {
        nonce: vaultRow!.nonce,
        ciphertext: vaultRow!.ciphertext,
        authTag: vaultRow!.authTag,
      },
    });
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    expect(parsed.access_token).toBe("e2e-access-token");
    expect(parsed.refresh_token).toBe("e2e-refresh-token");
    expect(typeof parsed.expires_at).toBe("string");
  });

  it("9. lock is released even when refresh throws (finally block)", async () => {
    const acct = await seedAccount();
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    });

    nextTokenResponse = { status: 500, body: JSON.stringify({ error: "internal_error" }) };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    };

    await expect(
      maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
        masterKeyHex: MASTER_KEY,
        leadMinutes: 10,
        maxFail: 3,
        tokenUrl: tokenBaseUrl,
      }),
    ).rejects.toBeInstanceOf(OAuthRefreshError);

    const lockKey = `oauth-refresh:${acct.id}`;
    const exists = await redis.exists(lockKey);
    expect(exists).toBe(0);
  });

  it("10. token endpoint receives correct body { grant_type, refresh_token, client_id }", async () => {
    const acct = await seedAccount();
    const expiresAt = staleExpiresAt();
    await seedVault(acct.id, {
      accessToken: "my-access",
      refreshToken: "my-refresh-token-123",
      expiresAt,
    });

    nextTokenResponse = {
      status: 200,
      body: JSON.stringify({
        access_token: "newer-access",
        refresh_token: "newer-refresh",
        expires_in: 3600,
      }),
    };

    const redis = makeRedis();
    const currentCredential: Extract<ResolvedCredential, { type: "oauth" }> = {
      type: "oauth",
      accessToken: "my-access",
      refreshToken: "my-refresh-token-123",
      expiresAt,
    };

    const testClientId = "test-client-id-override";
    await maybeRefreshOAuth(db as never, redis, acct.id, currentCredential, {
      masterKeyHex: MASTER_KEY,
      leadMinutes: 10,
      maxFail: 3,
      tokenUrl: tokenBaseUrl,
      clientId: testClientId,
    });

    expect(lastTokenRequest).not.toBeNull();
    const body = JSON.parse(lastTokenRequest!.body) as Record<string, unknown>;
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("my-refresh-token-123");
    expect(body.client_id).toBe(testClientId);
  });
});

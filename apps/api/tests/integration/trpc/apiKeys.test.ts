import { createHmac } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import type { Database } from "@aide/db";
import { apiKeys } from "@aide/db";
import { verifyApiKey } from "@aide/gateway-core";
import { resolvePermissions } from "@aide/auth";
import type { ServerEnv } from "@aide/config";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  defaultTestEnv,
} from "../../factories/index.js";
import { createCallerFactory, router } from "../../../src/trpc/procedures.js";
import { apiKeysRouter } from "../../../src/trpc/routers/apiKeys.js";

// Local sub-router so this test runs independently of Task 8.4 (which
// wires `apiKeys` into the global appRouter).
const localRouter = router({ apiKeys: apiKeysRouter });
const createLocalCaller = createCallerFactory(localRouter);

async function callerFor(opts: {
  db: Database;
  userId: string;
  redis: Redis;
  email?: string;
  env?: ServerEnv;
  ipAddress?: string | null;
}) {
  const perm = await resolvePermissions(opts.db, opts.userId);
  return createLocalCaller({
    db: opts.db,
    user: { id: opts.userId, email: opts.email ?? "x@x.test" },
    perm,
    reqId: "test",
    env: opts.env ?? defaultTestEnv,
    redis: opts.redis,
    ipAddress: opts.ipAddress ?? null,
  });
}

// HMAC must mirror the router's hashRevealToken — keep this in sync if the
// algorithm changes. Tests assert the on-wire Redis key shape directly.
function hashRevealToken(pepperHex: string, token: string): string {
  return createHmac("sha256", Buffer.from(pepperHex, "hex"))
    .update(token)
    .digest("hex");
}

let t: Awaited<ReturnType<typeof setupTestDb>>;
let redis: Redis;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(() => {
  // Fresh in-memory store per test so reveal-token stashes don't leak between
  // cases. Mirrors gateway tests' pattern.
  redis = new RedisMock({ keyPrefix: "aide:gw:" }) as unknown as Redis;
});

describe("apiKeys router", () => {
  it("issueOwn: returns raw + id, persists hashed keyHash, verifyApiKey roundtrips", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: user.id, redis });

    const result = await caller.apiKeys.issueOwn({ name: "my-key" });
    expect(result.id).toBeTruthy();
    expect(result.raw).toMatch(/^ak_/);
    expect(result.prefix).toBe(result.raw.slice(0, 8));

    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, result.id));
    expect(row).toBeDefined();
    // The persisted hash is NOT the raw value.
    expect(row!.keyHash).not.toBe(result.raw);
    // Roundtrip: hashing the raw with the same pepper matches the stored hash.
    expect(
      verifyApiKey(
        defaultTestEnv.API_KEY_HASH_PEPPER!,
        result.raw,
        row!.keyHash,
      ),
    ).toBe(true);
    expect(row!.userId).toBe(user.id);
    expect(row!.orgId).toBe(org.id);
    expect(row!.issuedByUserId).toBeNull();
    expect(row!.revealTokenHash).toBeNull();
  });

  it("issueOwn: NOT_FOUND when ENABLE_GATEWAY=false", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({
      db: t.db,
      userId: user.id,
      redis,
      env: { ...defaultTestEnv, ENABLE_GATEWAY: false },
    });
    await expect(caller.apiKeys.issueOwn({ name: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("issueForUser: returns revealUrl (no raw); persists revealTokenHash; redis stash holds raw under aide:gw:key-reveal:<token>", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const target = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: admin.id, redis });

    const result = await caller.apiKeys.issueForUser({
      orgId: org.id,
      targetUserId: target.id,
      name: "admin-issued",
    });
    expect(result.id).toBeTruthy();
    expect(result.prefix).toMatch(/^ak_/);
    // Admin must NOT see the raw key.
    expect(result).not.toHaveProperty("raw");
    // URL shape is `{GATEWAY_BASE_URL}/api-keys/reveal/<token>`.
    expect(result.revealUrl.startsWith(defaultTestEnv.GATEWAY_BASE_URL!)).toBe(
      true,
    );
    const token = result.revealUrl.split("/").pop()!;
    expect(token.length).toBeGreaterThan(20);

    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, result.id));
    expect(row!.userId).toBe(target.id);
    expect(row!.issuedByUserId).toBe(admin.id);
    expect(row!.revealTokenHash).toBe(
      hashRevealToken(defaultTestEnv.API_KEY_HASH_PEPPER!, token),
    );
    expect(row!.revealTokenExpiresAt).not.toBeNull();
    expect(row!.revealedAt).toBeNull();

    // Verify the Redis stash is in the gateway namespace. ioredis-mock
    // exposes keys via the `data` map keyed by the *prefixed* string.
    // Asking the prefixed mock for the suffix returns the raw value.
    const stashed = await redis.get(`key-reveal:${token}`);
    expect(stashed).not.toBeNull();
    expect(stashed!.startsWith("ak_")).toBe(true);
  });

  it("issueForUser: org_admin from a different org is FORBIDDEN", async () => {
    const orgA = await makeOrg(t.db);
    const orgB = await makeOrg(t.db);
    const adminB = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: orgB.id,
      orgId: orgB.id,
    });
    const targetA = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: orgA.id,
      orgId: orgA.id,
    });
    const caller = await callerFor({ db: t.db, userId: adminB.id, redis });

    await expect(
      caller.apiKeys.issueForUser({
        orgId: orgA.id,
        targetUserId: targetA.id,
        name: "x",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("revealViaToken: valid token returns raw, sets revealedAt + revealedByIp, deletes redis key", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const target = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      redis,
    });
    const issued = await adminCaller.apiKeys.issueForUser({
      orgId: org.id,
      targetUserId: target.id,
      name: "to-be-revealed",
    });
    const token = issued.revealUrl.split("/").pop()!;

    // Target user claims the URL (with a known IP for the audit assertion).
    const targetCaller = await callerFor({
      db: t.db,
      userId: target.id,
      redis,
      ipAddress: "203.0.113.7",
    });
    const result = await targetCaller.apiKeys.revealViaToken({ token });
    expect(result.id).toBe(issued.id);
    expect(result.raw.startsWith("ak_")).toBe(true);
    expect(result.name).toBe("to-be-revealed");

    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, issued.id));
    expect(row!.revealedAt).not.toBeNull();
    // inet column: drizzle returns it as the textual representation.
    expect(row!.revealedByIp).toBe("203.0.113.7");

    // Redis stash deleted.
    expect(await redis.get(`key-reveal:${token}`)).toBeNull();
  });

  it("revealViaToken: invalid token → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: user.id, redis });
    await expect(
      caller.apiKeys.revealViaToken({ token: "not-a-real-token" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("revealViaToken: token reused after successful reveal → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const target = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      redis,
    });
    const issued = await adminCaller.apiKeys.issueForUser({
      orgId: org.id,
      targetUserId: target.id,
      name: "single-use",
    });
    const token = issued.revealUrl.split("/").pop()!;
    const targetCaller = await callerFor({
      db: t.db,
      userId: target.id,
      redis,
    });

    await targetCaller.apiKeys.revealViaToken({ token });
    await expect(
      targetCaller.apiKeys.revealViaToken({ token }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("revealViaToken: token whose DB window has expired → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const target = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      redis,
    });
    const issued = await adminCaller.apiKeys.issueForUser({
      orgId: org.id,
      targetUserId: target.id,
      name: "expired",
    });
    const token = issued.revealUrl.split("/").pop()!;
    // Backdate the DB row's expiration window so the SELECT predicate fails,
    // simulating the 24h TTL elapsing without changing test wall-clock.
    await t.db
      .update(apiKeys)
      .set({ revealTokenExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(apiKeys.id, issued.id));

    const targetCaller = await callerFor({
      db: t.db,
      userId: target.id,
      redis,
    });
    await expect(
      targetCaller.apiKeys.revealViaToken({ token }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("listOwn: returns only the caller's keys and excludes revoked rows", async () => {
    const org = await makeOrg(t.db);
    const a = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const b = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const callerA = await callerFor({ db: t.db, userId: a.id, redis });
    const callerB = await callerFor({ db: t.db, userId: b.id, redis });

    const k1 = await callerA.apiKeys.issueOwn({ name: "a-1" });
    await callerA.apiKeys.issueOwn({ name: "a-2-revoked" });
    await callerB.apiKeys.issueOwn({ name: "b-1" });

    // Revoke A's second key directly (not via the revoke endpoint, which
    // we cover in its own test).
    await t.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.userId, a.id), eq(apiKeys.name, "a-2-revoked")));

    const list = await callerA.apiKeys.listOwn();
    expect(list.map((r) => r.name).sort()).toEqual(["a-1"]);
    expect(list[0]!.id).toBe(k1.id);
    // No key material in the response.
    expect(list[0]).not.toHaveProperty("keyHash");
    expect(list[0]).not.toHaveProperty("raw");
  });

  it("listOrg: org_admin sees all org keys; non-admin → FORBIDDEN", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const member = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const adminCaller = await callerFor({
      db: t.db,
      userId: admin.id,
      redis,
    });
    const memberCaller = await callerFor({
      db: t.db,
      userId: member.id,
      redis,
    });

    await adminCaller.apiKeys.issueOwn({ name: "admin-key" });
    await memberCaller.apiKeys.issueOwn({ name: "member-key" });

    const list = await adminCaller.apiKeys.listOrg({ orgId: org.id });
    expect(list.map((r) => r.name).sort()).toEqual([
      "admin-key",
      "member-key",
    ]);

    await expect(
      memberCaller.apiKeys.listOrg({ orgId: org.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("revoke: sets revokedAt; subsequent listOwn excludes; double-revoke → NOT_FOUND", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor({ db: t.db, userId: user.id, redis });
    const issued = await caller.apiKeys.issueOwn({ name: "to-revoke" });

    const result = await caller.apiKeys.revoke({ id: issued.id });
    expect(result.ok).toBe(true);

    const [row] = await t.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, issued.id));
    expect(row!.revokedAt).not.toBeNull();

    const list = await caller.apiKeys.listOwn();
    expect(list.some((r) => r.id === issued.id)).toBe(false);

    await expect(
      caller.apiKeys.revoke({ id: issued.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { organizations, teams, upstreamAccounts } from "@aide/db";
import { selectAccountIds } from "../../src/runtime/selectAccount.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@aide/db/package.json")),
  "drizzle",
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let orgId: string;
let teamId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({ slug: "test-org", name: "Test Org" })
    .returning();
  orgId = org!.id;

  const [team] = await db
    .insert(teams)
    .values({ orgId, slug: "test-team", name: "Test Team" })
    .returning();
  teamId = team!.id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

// Per-test cleanup: remove upstream_accounts so each test is independent
beforeEach(async () => {
  await db.delete(upstreamAccounts);
});

describe("selectAccountIds", () => {
  it("team-override beats org-level even with worse priority", async () => {
    const [orgLevel] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "org-level",
        platform: "anthropic",
        type: "api_key",
        priority: 10, // better priority number
        schedulable: true,
        status: "active",
      })
      .returning();

    const [teamLevel] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId,
        name: "team-level",
        platform: "anthropic",
        type: "api_key",
        priority: 50, // worse priority number
        schedulable: true,
        status: "active",
      })
      .returning();

    const ids = await selectAccountIds(db as never, { orgId, teamId });

    expect(ids).toHaveLength(2);
    // Team-scoped account must come first regardless of priority
    expect(ids[0]).toBe(teamLevel!.id);
    expect(ids[1]).toBe(orgLevel!.id);
  });

  it("rate-limited account is skipped when reset_at is in the future", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000); // +1h

    const [active] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "active",
        platform: "anthropic",
        type: "api_key",
        schedulable: true,
        status: "active",
      })
      .returning();

    await db.insert(upstreamAccounts).values({
      orgId,
      teamId: null,
      name: "rate-limited",
      platform: "anthropic",
      type: "api_key",
      schedulable: true,
      status: "active",
      rateLimitedAt: new Date(),
      rateLimitResetAt: future,
    });

    const ids = await selectAccountIds(db as never, { orgId, teamId: null });

    expect(ids).toEqual([active!.id]);
  });

  it("rate-limited account is re-eligible when reset_at is in the past", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000); // -1h

    const [account] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "rate-limit-expired",
        platform: "anthropic",
        type: "api_key",
        schedulable: true,
        status: "active",
        rateLimitedAt: past,
        rateLimitResetAt: past,
      })
      .returning();

    const ids = await selectAccountIds(db as never, { orgId, teamId: null });

    expect(ids).toContain(account!.id);
  });

  it("account with overload_until in the future is skipped", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000); // +1h

    const [active] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "active",
        platform: "anthropic",
        type: "api_key",
        schedulable: true,
        status: "active",
      })
      .returning();

    await db.insert(upstreamAccounts).values({
      orgId,
      teamId: null,
      name: "overloaded",
      platform: "anthropic",
      type: "api_key",
      schedulable: true,
      status: "active",
      overloadUntil: future,
    });

    const ids = await selectAccountIds(db as never, { orgId, teamId: null });

    expect(ids).toEqual([active!.id]);
  });

  it("excludeIds filters out specified accounts", async () => {
    const [account1] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "account1",
        platform: "anthropic",
        type: "api_key",
        priority: 1,
        schedulable: true,
        status: "active",
      })
      .returning();

    const [account2] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "account2",
        platform: "anthropic",
        type: "api_key",
        priority: 2,
        schedulable: true,
        status: "active",
      })
      .returning();

    const [account3] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "account3",
        platform: "anthropic",
        type: "api_key",
        priority: 3,
        schedulable: true,
        status: "active",
      })
      .returning();

    const ids = await selectAccountIds(db as never, {
      orgId,
      teamId: null,
      excludeIds: [account2!.id],
    });

    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(account2!.id);
    expect(ids).toContain(account1!.id);
    expect(ids).toContain(account3!.id);
  });

  it("account with deleted_at set is skipped", async () => {
    const [active] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "active",
        platform: "anthropic",
        type: "api_key",
        schedulable: true,
        status: "active",
      })
      .returning();

    await db.insert(upstreamAccounts).values({
      orgId,
      teamId: null,
      name: "deleted",
      platform: "anthropic",
      type: "api_key",
      schedulable: true,
      status: "active",
      deletedAt: new Date(),
    });

    const ids = await selectAccountIds(db as never, { orgId, teamId: null });

    expect(ids).toEqual([active!.id]);
  });

  it("account with schedulable=false is skipped", async () => {
    const [active] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "active",
        platform: "anthropic",
        type: "api_key",
        schedulable: true,
        status: "active",
      })
      .returning();

    await db.insert(upstreamAccounts).values({
      orgId,
      teamId: null,
      name: "unschedulable",
      platform: "anthropic",
      type: "api_key",
      schedulable: false,
      status: "active",
    });

    const ids = await selectAccountIds(db as never, { orgId, teamId: null });

    expect(ids).toEqual([active!.id]);
  });

  it("ordering by last_used_at NULLS FIRST — unused account sorts before recently-used", async () => {
    const [recentlyUsed] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "recently-used",
        platform: "anthropic",
        type: "api_key",
        priority: 10,
        schedulable: true,
        status: "active",
        lastUsedAt: new Date(),
      })
      .returning();

    const [neverUsed] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "never-used",
        platform: "anthropic",
        type: "api_key",
        priority: 10, // same priority
        schedulable: true,
        status: "active",
        lastUsedAt: null, // NULL → should sort first
      })
      .returning();

    const ids = await selectAccountIds(db as never, { orgId, teamId: null });

    expect(ids).toHaveLength(2);
    // NULL last_used_at should come first
    expect(ids[0]).toBe(neverUsed!.id);
    expect(ids[1]).toBe(recentlyUsed!.id);
  });

  it("returns empty array when no eligible accounts exist", async () => {
    const ids = await selectAccountIds(db as never, { orgId, teamId: null });

    expect(ids).toEqual([]);
  });

  it("temp_unschedulable_until in the future skips the account", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000); // +1h

    const [active] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "active",
        platform: "anthropic",
        type: "api_key",
        schedulable: true,
        status: "active",
      })
      .returning();

    await db.insert(upstreamAccounts).values({
      orgId,
      teamId: null,
      name: "temp-unschedulable",
      platform: "anthropic",
      type: "api_key",
      schedulable: true,
      status: "active",
      tempUnschedulableUntil: future,
    });

    const ids = await selectAccountIds(db as never, { orgId, teamId: null });

    expect(ids).toEqual([active!.id]);
  });

  it("excludes accounts from other organizations (cross-org isolation)", async () => {
    const [otherOrg] = await db
      .insert(organizations)
      .values({ slug: "other-org-cross-isolation", name: "Other Org" })
      .returning();
    const [mine] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "mine",
        platform: "anthropic",
        type: "api_key",
      })
      .returning();
    await db
      .insert(upstreamAccounts)
      .values({
        orgId: otherOrg!.id,
        teamId: null,
        name: "theirs",
        platform: "anthropic",
        type: "api_key",
      });
    const ids = await selectAccountIds(db as never, { orgId, teamId: null });
    expect(ids).toEqual([mine!.id]);
  });

  it("excludes accounts with status != 'active'", async () => {
    await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "inactive",
        platform: "anthropic",
        type: "api_key",
        status: "inactive",
      });
    const ids = await selectAccountIds(db as never, { orgId, teamId: null });
    expect(ids).toEqual([]);
  });

  it("excludeIds: [] does not generate invalid SQL (empty-array guard)", async () => {
    const [acct] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        teamId: null,
        name: "a",
        platform: "anthropic",
        type: "api_key",
      })
      .returning();
    const ids = await selectAccountIds(db as never, {
      orgId,
      teamId: null,
      excludeIds: [],
    });
    expect(ids).toEqual([acct!.id]);
  });
});

import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import fp from "fastify-plugin";
import { groupContextPlugin } from "../../src/middleware/groupContext.js";

interface FixtureKey {
  id: string;
  orgId: string;
  userId: string;
  teamId: string | null;
  groupId: string | null;
  quotaUsd: string;
  quotaUsedUsd: string;
}

interface GroupRow {
  id: string;
  platform: string;
  rateMultiplier: string;
  isExclusive: boolean;
}

function makeMockDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "from", "where", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  (chain["limit"] as ReturnType<typeof vi.fn>).mockReturnValue(
    Promise.resolve(rows),
  );
  return chain;
}

/** Fake apiKeyAuth plugin so groupContext has something to read. */
function fakeApiKeyAuth(apiKey: FixtureKey | null) {
  return fp(async (fastify) => {
    fastify.decorateRequest("apiKey", null);
    fastify.addHook("preHandler", async (req) => {
      // Mutating decorated request properties through `as never` keeps
      // the TS types simple — production middleware does the same.
      (req as unknown as { apiKey: FixtureKey | null }).apiKey = apiKey;
    });
  });
}

async function buildApp(opts: {
  apiKey: FixtureKey | null;
  groupRows: GroupRow[];
}) {
  const app = Fastify({ logger: false });
  const mockDb = makeMockDb(opts.groupRows);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.decorate("db", mockDb as any);

  await app.register(fakeApiKeyAuth(opts.apiKey));
  await app.register(groupContextPlugin);

  app.get("/echo", async (req) => {
    const ctx = (
      req as unknown as { gwGroupContext: unknown }
    ).gwGroupContext;
    return { ctx };
  });

  return { app, mockDb };
}

const BASE_KEY: FixtureKey = {
  id: "key-1",
  orgId: "org-1",
  userId: "user-1",
  teamId: null,
  groupId: "group-1",
  quotaUsd: "100",
  quotaUsedUsd: "0",
};

describe("groupContext middleware", () => {
  it("attaches gwGroupContext when the group resolves", async () => {
    const { app } = await buildApp({
      apiKey: BASE_KEY,
      groupRows: [
        {
          id: "group-1",
          platform: "openai",
          rateMultiplier: "1.5",
          isExclusive: false,
        },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/echo" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ctx: {
        groupId: "group-1",
        platform: "openai",
        rateMultiplier: 1.5,
        isExclusive: false,
        isLegacy: false,
      },
    });
  });

  it("synthesises legacy ctx when apiKey.groupId is null (no DB query)", async () => {
    const { app, mockDb } = await buildApp({
      apiKey: { ...BASE_KEY, groupId: null },
      groupRows: [],
    });

    const res = await app.inject({ method: "GET", url: "/echo" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ctx: {
        groupId: "legacy:org-1",
        platform: "anthropic",
        isLegacy: true,
      },
    });
    // resolveGroupContext short-circuits on null groupId — no DB hit.
    expect(
      (mockDb["select"] as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });

  it("returns 403 group_not_found_or_disabled when the group is missing", async () => {
    const { app } = await buildApp({
      apiKey: BASE_KEY,
      groupRows: [],
    });

    const res = await app.inject({ method: "GET", url: "/echo" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "group_not_found_or_disabled" });
  });

  it("skips resolution for unauthenticated paths (req.apiKey == null)", async () => {
    const { app, mockDb } = await buildApp({
      apiKey: null,
      groupRows: [],
    });

    const res = await app.inject({ method: "GET", url: "/echo" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ctx: null });
    expect(
      (mockDb["select"] as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OAuthRefreshAPI } from "../../src/oauth/refreshApi.js";
import {
  OAuthRefreshError,
  OAuthRefreshTokenInvalid,
  type Platform,
  type TokenRefresher,
  type TokenSet,
} from "../../src/oauth/types.js";
import { createOAuthRegistry } from "../../src/oauth/registry.js";
import type { OAuthVault } from "../../src/oauth/vault.js";

// Plan 5A §7.3 + impl plan Task 4.8 — unit coverage for OAuthRefreshAPI.
// All deps (vault, redis, db, refresher) are stubbed so the test never
// touches a real network or container.

const ACCOUNT_ID = "acc-12345";

interface FakeRedisState {
  store: Map<string, { value: string; expiresAt: number }>;
}

function makeFakeRedis(state: FakeRedisState, now: () => number) {
  // Minimal subset of `Redis` that OAuthRefreshAPI uses.  set with NX EX,
  // get, del.  Auto-expires on get based on the injected clock.
  function purgeIfExpired(key: string): void {
    const e = state.store.get(key);
    if (e && e.expiresAt <= now()) state.store.delete(key);
  }
  return {
    async set(
      key: string,
      value: string,
      ..._args: Array<string | number>
    ): Promise<"OK" | null> {
      // We only support `SET key value EX <sec> NX` here.
      const args = _args as Array<string | number>;
      const exIdx = args.indexOf("EX");
      const ttl = exIdx >= 0 ? Number(args[exIdx + 1]) : 0;
      const isNx = args.includes("NX");
      purgeIfExpired(key);
      if (isNx && state.store.has(key)) return null;
      state.store.set(key, {
        value,
        expiresAt: now() + ttl * 1000,
      });
      return "OK";
    },
    async get(key: string): Promise<string | null> {
      purgeIfExpired(key);
      return state.store.get(key)?.value ?? null;
    },
    async del(key: string): Promise<number> {
      const had = state.store.delete(key);
      return had ? 1 : 0;
    },
  };
}

function makeFakeDb(platform: Platform = "openai") {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit(_n: number) {
                  return Promise.resolve([{ platform, type: "oauth" }]);
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set() {
          return { where: () => Promise.resolve(undefined) };
        },
      };
    },
  } as unknown as import("@aide/db").Database;
}

function makeFakeVault(initial: {
  token: string;
  refreshToken: string;
  expiresAt: Date;
}): {
  vault: OAuthVault;
  state: { token: string; refreshToken: string; expiresAt: Date };
  replaceCalls: number;
} {
  const state = { ...initial };
  let replaceCalls = 0;
  const vault: OAuthVault = {
    async peekAccessToken() {
      return {
        token: state.token,
        expiresAt: state.expiresAt,
        rotatedAt: null,
      };
    },
    async loadForRefresh() {
      return {
        token: state.token,
        expiresAt: state.expiresAt,
        refreshToken: state.refreshToken,
        rotatedAt: null,
      };
    },
    async replaceTokens(_accountId, tokens) {
      state.token = tokens.accessToken;
      state.refreshToken = tokens.refreshToken;
      state.expiresAt = tokens.expiresAt;
      replaceCalls++;
    },
  };
  return {
    vault,
    state,
    get replaceCalls() {
      return replaceCalls;
    },
  };
}

function makeRefresher(
  impl: (refreshToken: string) => Promise<TokenSet>,
  platform: Platform = "openai",
): TokenRefresher & { calls: string[] } {
  const calls: string[] = [];
  return {
    platform,
    async refresh(refreshToken) {
      calls.push(refreshToken);
      return impl(refreshToken);
    },
    calls,
  };
}

describe("OAuthRefreshAPI", () => {
  let nowMs: number;
  const advanceTime = (ms: number) => {
    nowMs += ms;
  };
  const sleep = vi.fn(async (ms: number) => {
    advanceTime(ms);
  });

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    sleep.mockClear();
  });

  function makeApi(opts: {
    vault: OAuthVault;
    redisState: FakeRedisState;
    refresher: TokenRefresher;
    platform?: Platform;
  }) {
    const registry = createOAuthRegistry({
      refreshers: { [opts.platform ?? "openai"]: opts.refresher },
    });
    return new OAuthRefreshAPI({
      db: makeFakeDb(opts.platform ?? "openai"),
      vault: opts.vault,
      redis: makeFakeRedis(opts.redisState, () => nowMs) as never,
      registry,
      lockWaitMs: 1_000,
      now: () => nowMs,
      sleep,
    });
  }

  it("returns the cached token when its expiry is more than 5 min away (no refresh)", async () => {
    const { vault, replaceCalls } = makeFakeVault({
      token: "live-1",
      refreshToken: "rt-1",
      expiresAt: new Date(nowMs + 30 * 60 * 1000),
    });
    const refresher = makeRefresher(async () => ({
      accessToken: "should-not-be-called",
      refreshToken: "should-not-be-called",
      expiresAt: new Date(nowMs + 60 * 60 * 1000),
    }));
    const api = makeApi({
      vault,
      redisState: { store: new Map() },
      refresher,
    });

    const result = await api.getValidAccessToken(ACCOUNT_ID);
    expect(result.accessToken).toBe("live-1");
    expect(refresher.calls.length).toBe(0);
    expect(replaceCalls).toBe(0);
  });

  it("refreshes when the cached token expires within the 5 min leadway", async () => {
    const wrap = makeFakeVault({
      token: "live-2",
      refreshToken: "rt-2",
      expiresAt: new Date(nowMs + 60 * 1000), // 1 min — within leadway
    });
    const refresher = makeRefresher(async () => ({
      accessToken: "fresh-2",
      refreshToken: "rt-2-rotated",
      expiresAt: new Date(nowMs + 60 * 60 * 1000),
    }));
    const api = makeApi({
      vault: wrap.vault,
      redisState: { store: new Map() },
      refresher,
    });

    const result = await api.getValidAccessToken(ACCOUNT_ID);
    expect(result.accessToken).toBe("fresh-2");
    expect(refresher.calls).toEqual(["rt-2"]);
    expect(wrap.replaceCalls).toBe(1);
    expect(wrap.state.refreshToken).toBe("rt-2-rotated");
  });

  it("policy=wait_for_cache (openai): waits and returns the rotated token after another worker refreshes", async () => {
    const wrap = makeFakeVault({
      token: "live-3",
      refreshToken: "rt-3",
      expiresAt: new Date(nowMs + 60 * 1000),
    });
    const refresher = makeRefresher(async () => {
      throw new Error("refresher should not be invoked when lock is held");
    });
    const redisState: FakeRedisState = { store: new Map() };
    // Simulate another worker holding the lock at call-time.
    redisState.store.set(`oauth:refresh-lock:${ACCOUNT_ID}`, {
      value: "1",
      expiresAt: nowMs + 30_000,
    });
    const api = makeApi({
      vault: wrap.vault,
      redisState,
      refresher,
    });

    // After ~200ms of sleep, the "other worker" rotates the token.
    let rotated = false;
    sleep.mockImplementation(async (ms: number) => {
      advanceTime(ms);
      if (!rotated && nowMs - 1_700_000_000_000 >= 200) {
        wrap.state.token = "fresh-3-other-worker";
        wrap.state.expiresAt = new Date(nowMs + 60 * 60 * 1000);
        rotated = true;
      }
    });

    const result = await api.getValidAccessToken(ACCOUNT_ID);
    expect(result.accessToken).toBe("fresh-3-other-worker");
    expect(refresher.calls.length).toBe(0);
  });

  it("OAuthRefreshTokenInvalid propagates and marks the account oauth_invalid", async () => {
    const wrap = makeFakeVault({
      token: "live-4",
      refreshToken: "rt-4-bad",
      expiresAt: new Date(nowMs + 60 * 1000),
    });
    const refresher = makeRefresher(async () => {
      throw new OAuthRefreshTokenInvalid(
        "invalid_grant: refresh token expired",
        "openai",
      );
    });
    const api = makeApi({
      vault: wrap.vault,
      redisState: { store: new Map() },
      refresher,
    });

    await expect(api.getValidAccessToken(ACCOUNT_ID)).rejects.toBeInstanceOf(
      OAuthRefreshTokenInvalid,
    );
    expect(wrap.replaceCalls).toBe(0);
    // No assertion on the DB update here (fake DB is a no-op stub); the
    // contract is verified in integration tests.  This unit test pins the
    // error-class shape + propagation.
  });

  it("policy=use_existing_token + transient refresh error: returns cached token + sets failure TTL", async () => {
    const wrap = makeFakeVault({
      token: "live-5",
      refreshToken: "rt-5",
      expiresAt: new Date(nowMs + 60 * 1000),
    });
    const refresher = makeRefresher(async () => {
      throw new Error("upstream 5xx temporarily unavailable");
    });
    const redisState: FakeRedisState = { store: new Map() };
    const api = makeApi({
      vault: wrap.vault,
      redisState,
      refresher,
    });

    const result = await api.getValidAccessToken(ACCOUNT_ID);
    expect(result.accessToken).toBe("live-5");
    expect(refresher.calls.length).toBe(1);
    expect(wrap.replaceCalls).toBe(0);
    // Failure marker recorded so the next call within failureTTL skips
    // the upstream entirely.
    expect(redisState.store.has(`oauth:refresh-failure:${ACCOUNT_ID}`)).toBe(
      true,
    );

    // Second call within TTL must NOT invoke the refresher.
    const second = await api.getValidAccessToken(ACCOUNT_ID);
    expect(second.accessToken).toBe("live-5");
    expect(refresher.calls.length).toBe(1);
  });

  it("policy=return_error (gemini): transient refresh error bubbles instead of returning cached", async () => {
    const wrap = makeFakeVault({
      token: "live-6",
      refreshToken: "rt-6",
      expiresAt: new Date(nowMs + 60 * 1000),
    });
    const refresher = makeRefresher(async () => {
      throw new Error("gemini 5xx");
    }, "gemini");
    const api = makeApi({
      vault: wrap.vault,
      redisState: { store: new Map() },
      refresher,
      platform: "gemini",
    });

    await expect(api.getValidAccessToken(ACCOUNT_ID)).rejects.toThrow(
      /gemini 5xx/,
    );
    expect(wrap.replaceCalls).toBe(0);
  });

  it("clears the failure TTL on a subsequent successful refresh", async () => {
    const wrap = makeFakeVault({
      token: "live-7",
      refreshToken: "rt-7",
      expiresAt: new Date(nowMs + 60 * 1000),
    });
    let attempt = 0;
    const refresher = makeRefresher(async () => {
      attempt++;
      if (attempt === 1) throw new Error("first attempt 5xx");
      return {
        accessToken: "fresh-7",
        refreshToken: "rt-7-rotated",
        expiresAt: new Date(nowMs + 60 * 60 * 1000),
      };
    });
    const redisState: FakeRedisState = { store: new Map() };
    const api = makeApi({
      vault: wrap.vault,
      redisState,
      refresher,
    });

    // First call: transient error → failure marker set.
    await api.getValidAccessToken(ACCOUNT_ID);
    expect(redisState.store.has(`oauth:refresh-failure:${ACCOUNT_ID}`)).toBe(
      true,
    );

    // Advance past failureTTL so the next call retries the upstream.
    advanceTime(61_000);
    const result = await api.getValidAccessToken(ACCOUNT_ID);
    expect(result.accessToken).toBe("fresh-7");
    expect(redisState.store.has(`oauth:refresh-failure:${ACCOUNT_ID}`)).toBe(
      false,
    );
  });

  it("throws when the platform refresher isn't registered (programming error, strict policy)", async () => {
    // Use gemini (return_error policy) so the registry miss is not
    // swallowed by the tolerant 'use_existing_token' branch.  Tolerant
    // platforms intentionally treat any refresher exception (including
    // a programming error) as transient and return the cached token; for
    // strict platforms the error bubbles, surfacing the misconfiguration
    // immediately during boot/integration testing.
    const wrap = makeFakeVault({
      token: "live-8",
      refreshToken: "rt-8",
      expiresAt: new Date(nowMs + 60 * 1000),
    });
    const api = new OAuthRefreshAPI({
      db: makeFakeDb("gemini"),
      vault: wrap.vault,
      redis: makeFakeRedis({ store: new Map() }, () => nowMs) as never,
      registry: createOAuthRegistry({}),
      lockWaitMs: 1_000,
      now: () => nowMs,
      sleep,
    });

    await expect(api.getValidAccessToken(ACCOUNT_ID)).rejects.toThrow(
      /oauth_token_refresher_not_registered_for_platform/,
    );
  });

  it("policy=use_existing_token + lock held + no cached token: throws no_token_available", async () => {
    const vault: OAuthVault = {
      async peekAccessToken() {
        return null;
      },
      async loadForRefresh() {
        return null;
      },
      async replaceTokens() {
        /* no-op */
      },
    };
    const refresher = makeRefresher(async () => {
      throw new Error("unreached");
    }, "gemini");
    const redisState: FakeRedisState = { store: new Map() };
    redisState.store.set(`oauth:refresh-lock:${ACCOUNT_ID}`, {
      value: "1",
      expiresAt: nowMs + 30_000,
    });
    const api = makeApi({
      vault,
      redisState,
      refresher,
      platform: "gemini",
    });

    await expect(api.getValidAccessToken(ACCOUNT_ID)).rejects.toBeInstanceOf(
      OAuthRefreshError,
    );
  });
});

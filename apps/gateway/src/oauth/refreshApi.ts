import type { Redis } from "ioredis";
import type { Database } from "@aide/db";
import { upstreamAccounts } from "@aide/db";
import { eq } from "drizzle-orm";
import {
  OAuthLockTimeoutError,
  OAuthRefreshError,
  OAuthRefreshTokenInvalid,
  type Platform,
  type RefreshPolicy,
  type TokenSet,
} from "./types.js";
import {
  getTokenRefresher,
  type OAuthRegistry,
} from "./registry.js";
import { getPolicy } from "./policies.js";
import type { OAuthVault } from "./vault.js";

// Plan 5A §7.3 — unified `OAuthRefreshAPI`.  Single chokepoint that fronts
// every read of an OAuth access token in 5A:
//
//   - Hot path: cached access token still valid → return it immediately.
//   - Refresh path: cache miss / expiring within 5 min → acquire a Redis
//     lock keyed on the account, run the platform's TokenRefresher, write
//     atomically via the vault CAS, release the lock.
//   - Lock-held path: another worker is already refreshing.  Behaviour
//     depends on `RefreshPolicy.onLockHeld`:
//       * `wait_for_cache` → poll the vault for up to `lockWaitMs` and
//         return the freshly-rotated token when it arrives.
//       * `use_existing_token` → immediately return the cached token (or
//         throw `no_token_available` when there isn't one).
//   - Error path: TokenRefresher throws.  `OAuthRefreshTokenInvalid`
//     ALWAYS propagates (caller marks account oauth_invalid + alerts);
//     other errors honour `RefreshPolicy.onRefreshError`.
//
// In 5A only OpenAI is registered (PR 5).  Anthropic continues to refresh
// through the legacy monolithic `runtime/oauthRefresh.ts`; this class is
// therefore inert for Anthropic accounts until 5D refactors them in.

export interface OAuthRefreshAPIDeps {
  db: Database;
  vault: OAuthVault;
  redis: Redis;
  registry: OAuthRegistry;
  /** How long to poll the vault when another worker holds the lock. */
  lockWaitMs?: number;
  /** Test hook — defaults to `Date.now`. */
  now?: () => number;
  /** Test hook — defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_LOCK_TTL_SEC = 30;
const POLL_INTERVAL_MS = 100;
/** Refresh when current token expires within this window. */
const REFRESH_LEADWAY_MS = 5 * 60 * 1000;

const lockKeyFor = (accountId: string): string =>
  `oauth:refresh-lock:${accountId}`;
const failureKeyFor = (accountId: string): string =>
  `oauth:refresh-failure:${accountId}`;

export class OAuthRefreshAPI {
  private readonly db: Database;
  private readonly vault: OAuthVault;
  private readonly redis: Redis;
  private readonly registry: OAuthRegistry;
  private readonly lockWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: OAuthRefreshAPIDeps) {
    this.db = deps.db;
    this.vault = deps.vault;
    this.redis = deps.redis;
    this.registry = deps.registry;
    this.lockWaitMs = deps.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Returns a valid access token for `accountId`.  Refreshes if the cached
   * token is expiring within ~5 min.  Concurrency is funnelled through a
   * Redis lock so at most one refresh runs per account at a time.
   */
  async getValidAccessToken(
    accountId: string,
  ): Promise<{ accessToken: string }> {
    const account = await this.loadAccount(accountId);
    const policy = getPolicy(account.platform);

    const cached = await this.vault.peekAccessToken(accountId);
    if (cached && this.tokenStillFresh(cached.expiresAt)) {
      return { accessToken: cached.token };
    }

    const transient = await this.redis.get(failureKeyFor(accountId));
    if (transient && cached) {
      // Recent transient failure — honour failureTTL and serve the cached
      // token without hammering the upstream again.
      return { accessToken: cached.token };
    }

    const lockKey = lockKeyFor(accountId);
    const lockAcquired = await this.redis.set(
      lockKey,
      "1",
      "EX",
      DEFAULT_LOCK_TTL_SEC,
      "NX",
    );

    if (!lockAcquired) {
      return this.handleLockHeld(accountId, policy, cached);
    }

    try {
      return await this.performRefresh(accountId, account.platform, cached);
    } catch (err) {
      if (err instanceof OAuthRefreshTokenInvalid) {
        await this.markAccountOAuthInvalid(accountId, err.message);
        throw err;
      }
      if (policy.onRefreshError === "use_existing_token" && cached) {
        await this.recordTransientFailure(accountId, policy.failureTTLMs);
        return { accessToken: cached.token };
      }
      throw err;
    } finally {
      await this.redis.del(lockKey);
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private tokenStillFresh(expiresAt: Date): boolean {
    return expiresAt.getTime() > this.now() + REFRESH_LEADWAY_MS;
  }

  private async loadAccount(
    accountId: string,
  ): Promise<{ platform: Platform; type: string }> {
    const row = await this.db
      .select({
        platform: upstreamAccounts.platform,
        type: upstreamAccounts.type,
      })
      .from(upstreamAccounts)
      .where(eq(upstreamAccounts.id, accountId))
      .limit(1)
      .then((rs) => rs[0]);
    if (!row) {
      throw new OAuthRefreshError(`account_not_found: ${accountId}`);
    }
    return {
      platform: row.platform as Platform,
      type: row.type,
    };
  }

  private async handleLockHeld(
    accountId: string,
    policy: RefreshPolicy,
    cached: Awaited<ReturnType<OAuthVault["peekAccessToken"]>>,
  ): Promise<{ accessToken: string }> {
    if (policy.onLockHeld === "wait_for_cache") {
      const after = await this.waitForCacheRefresh(accountId, this.lockWaitMs);
      if (after) return { accessToken: after.token };
      throw new OAuthLockTimeoutError(accountId, this.lockWaitMs);
    }
    // 'use_existing_token'
    if (cached) return { accessToken: cached.token };
    throw new OAuthRefreshError(`no_token_available: ${accountId}`);
  }

  private async waitForCacheRefresh(
    accountId: string,
    timeoutMs: number,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);
      const peek = await this.vault.peekAccessToken(accountId);
      if (peek && this.tokenStillFresh(peek.expiresAt)) {
        return { token: peek.token, expiresAt: peek.expiresAt };
      }
    }
    return null;
  }

  private async performRefresh(
    accountId: string,
    platform: Platform,
    cachedHint: Awaited<ReturnType<OAuthVault["peekAccessToken"]>>,
  ): Promise<{ accessToken: string }> {
    const refresher = getTokenRefresher(this.registry, platform);
    const loaded = await this.vault.loadForRefresh(accountId);
    if (!loaded) {
      throw new OAuthRefreshError(
        `vault_row_missing_for_refresh: ${accountId}`,
      );
    }
    let tokens: TokenSet;
    try {
      tokens = await refresher.refresh(loaded.refreshToken);
    } catch (err) {
      if (err instanceof OAuthRefreshTokenInvalid) throw err;
      throw err;
    }
    await this.vault.replaceTokens(accountId, tokens, loaded.rotatedAt);
    // Clear any stale transient-failure marker so the next call can refresh
    // again immediately on success.
    await this.redis.del(failureKeyFor(accountId));
    return { accessToken: tokens.accessToken };
  }

  private async recordTransientFailure(
    accountId: string,
    ttlMs: number,
  ): Promise<void> {
    if (ttlMs <= 0) return;
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.redis.set(failureKeyFor(accountId), "1", "EX", ttlSec);
  }

  private async markAccountOAuthInvalid(
    accountId: string,
    reason: string,
  ): Promise<void> {
    const truncated = reason.length > 240 ? reason.slice(0, 240) : reason;
    await this.db
      .update(upstreamAccounts)
      .set({
        status: "oauth_invalid",
        schedulable: false,
        errorMessage: truncated,
        updatedAt: new Date(this.now()),
      })
      .where(eq(upstreamAccounts.id, accountId));
  }
}

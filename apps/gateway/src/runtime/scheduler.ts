// 3-layer account scheduler (Plan 5A Part 7).
//
// Replaces the single-layer `selectAccounts` priority chain used by 4A's
// `failoverLoop`. Three layers in priority order:
//
//   Layer 1 — `previous_response_id` sticky (Codex CLI multi-turn)
//   Layer 2 — `session_hash` sticky        (Claude Code conversations)
//   Layer 3 — load_balance with EWMA       (cold path / new sessions)
//
// Sticky layers require both a `groupId` (introduced in Plan 5A migration
// 0008) and Redis. When either is absent — e.g. legacy api-keys without
// `group_id`, or unit tests with no Redis client — we fall through to
// Layer 3 directly. This preserves all 4A behaviour for callers that
// haven't been migrated to group context yet (Part 8 wires `groupId` into
// the routes).
//
// Concurrency-slot acquisition stays in the caller's `attempt` callback
// for now (matches 4A); Part 8 will move it into the scheduler once the
// caller side is refactored to consume `release()` directly.

import { and, asc, eq, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { accountGroupMembers, accountGroups, upstreamAccounts } from "@aide/db";
import type { Database } from "@aide/db";
import type { Platform } from "@aide/gateway-core";
import { AccountRuntimeStats } from "./runtimeStats.js";
import {
  getRespSticky,
  setRespSticky,
  getSessionSticky,
  setSessionSticky,
} from "../redis/sticky.js";

export type ScheduleLayer =
  | "previous_response_id"
  | "session_hash"
  | "load_balance";

export interface ScheduleRequest {
  /** Org scope is always required for tenant isolation. */
  orgId: string;
  /** Team scope (if api key was issued under a team). null = org-level only. */
  teamId: string | null;
  /**
   * Group scope. When set, account selection joins
   * account_group_members + filters by group platform. When undefined,
   * the legacy org/team selection is used (Layer 3 only).
   */
  groupId?: string;
  /** Group platform — bound at resolveGroupContext time (Part 8). */
  groupPlatform?: Platform;
  /** Layer 1 sticky key (Codex CLI / OpenAI Responses). */
  previousResponseId?: string;
  /** Layer 2 sticky key (Claude Code / content hash). */
  sessionHash?: string;
  /**
   * Forces a specific account when set; bypasses all 3 layers. Used by
   * forward-deps that already know which account to hit (e.g. probeAccount).
   */
  stickyAccountId?: string;
  /** Best-effort model gate; pricingLookup will reject mismatches downstream. */
  requestedModel?: string;
  /** Accounts to filter out (failover already tried them). */
  excludedAccountIds?: ReadonlySet<string>;
}

export interface ScheduleDecision {
  layer: ScheduleLayer;
  stickyHit: boolean;
  candidateCount: number;
  selectedAccountId: string;
  selectedAccountType: string;
  loadSkew: number;
  latencyMs: number;
}

export interface ScheduledAccount {
  id: string;
  concurrency: number;
  platform: string;
  type: string;
  priority: number;
  groupId: string | null;
}

export interface ScheduleResult {
  account: ScheduledAccount;
  decision: ScheduleDecision;
  release: () => Promise<void>;
}

export interface SchedulerMetrics {
  recordSelect(decision: ScheduleDecision): void;
  recordSwitch(platform: string): void;
  recordLatency(platform: string, ms: number): void;
  recordLoadSkew(platform: string, skew: number): void;
  recordRuntimeAccountCount(platform: string, count: number): void;
}

export class NoSchedulableAccountsError extends Error {
  constructor(
    public readonly orgId: string,
    public readonly groupId: string | undefined,
    public readonly excludedCount: number,
  ) {
    super(
      `no schedulable accounts in org=${orgId}${groupId ? ` group=${groupId}` : ""} (excluded=${excludedCount})`,
    );
    this.name = "NoSchedulableAccountsError";
  }
}

export interface AccountScheduler {
  select(req: ScheduleRequest): Promise<ScheduleResult>;
  reportResult(
    accountId: string,
    success: boolean,
    firstTokenMs?: number,
  ): void;
  reportSwitch(platform?: string): void;
  snapshotRuntimeStats(): ReturnType<AccountRuntimeStats["snapshot"]>;
}

const DEFAULT_TOP_K = 3;
const DEFAULT_PLATFORM_LABEL = "unknown";

export interface CreateSchedulerOptions {
  db: Database;
  /**
   * Optional Redis client. Sticky layers no-op when omitted (legacy
   * callsites that never carry sticky keys still work).
   */
  redis?: Redis;
  /** Inject for tests so we can seed stats deterministically. */
  stats?: AccountRuntimeStats;
  /** Optional metric sink — `plugins/metrics.ts` wires the production one. */
  metrics?: SchedulerMetrics;
  /** Top-K candidates to weighted-random over in Layer 3. */
  topK?: number;
  /** Inject for tests. */
  now?: () => number;
  /** Inject for tests so weighted-random is deterministic. */
  random?: () => number;
}

export function createScheduler(
  opts: CreateSchedulerOptions,
): AccountScheduler {
  const stats = opts.stats ?? new AccountRuntimeStats();
  const metrics = opts.metrics;
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;

  return {
    async select(req: ScheduleRequest): Promise<ScheduleResult> {
      const t0 = now();
      const result = await runLayers({
        db: opts.db,
        redis: opts.redis,
        stats,
        topK,
        now,
        random,
        req,
      });
      const latencyMs = now() - t0;
      const decision: ScheduleDecision = {
        ...result.decision,
        latencyMs,
      };
      const platformLabel =
        req.groupPlatform ?? result.account.platform ?? DEFAULT_PLATFORM_LABEL;
      metrics?.recordSelect(decision);
      metrics?.recordLatency(platformLabel, latencyMs);
      metrics?.recordLoadSkew(platformLabel, decision.loadSkew);
      metrics?.recordRuntimeAccountCount(platformLabel, stats.size());
      return {
        account: result.account,
        decision,
        release: result.release,
      };
    },
    reportResult(accountId, success, firstTokenMs) {
      stats.record(accountId, success, firstTokenMs);
    },
    reportSwitch(platform) {
      metrics?.recordSwitch(platform ?? DEFAULT_PLATFORM_LABEL);
    },
    snapshotRuntimeStats() {
      return stats.snapshot();
    },
  };
}

interface InternalLayerInput {
  db: Database;
  redis?: Redis;
  stats: AccountRuntimeStats;
  topK: number;
  now: () => number;
  random: () => number;
  req: ScheduleRequest;
}

interface InternalLayerResult {
  account: ScheduledAccount;
  decision: Omit<ScheduleDecision, "latencyMs">;
  release: () => Promise<void>;
}

async function runLayers(
  input: InternalLayerInput,
): Promise<InternalLayerResult> {
  const { db, redis, stats, topK, random, req } = input;
  const excluded = req.excludedAccountIds ?? new Set<string>();

  // Forced override (probeAccount, etc.). Bypasses all 3 layers.
  if (req.stickyAccountId && !excluded.has(req.stickyAccountId)) {
    const account = await loadSchedulableAccount(db, req.stickyAccountId, req);
    if (account) {
      return {
        account,
        decision: {
          layer: "previous_response_id",
          stickyHit: true,
          candidateCount: 1,
          selectedAccountId: account.id,
          selectedAccountType: account.type,
          loadSkew: 0,
        },
        release: noopRelease,
      };
    }
  }

  // Layer 1 — previous_response_id sticky (groupId + redis required)
  if (redis && req.groupId && req.previousResponseId) {
    const cachedAccountId = await getRespSticky(
      redis,
      req.groupId,
      req.previousResponseId,
    );
    if (cachedAccountId && !excluded.has(cachedAccountId)) {
      const account = await loadSchedulableAccount(db, cachedAccountId, {
        ...req,
        groupId: req.groupId,
      });
      if (account) {
        // Refresh TTL on hit so an active conversation keeps its binding alive.
        await setRespSticky(
          redis,
          req.groupId,
          req.previousResponseId,
          account.id,
        );
        return {
          account,
          decision: {
            layer: "previous_response_id",
            stickyHit: true,
            candidateCount: 1,
            selectedAccountId: account.id,
            selectedAccountType: account.type,
            loadSkew: 0,
          },
          release: noopRelease,
        };
      }
    }
  }

  // Layer 2 — session_hash sticky (groupId + redis required)
  if (redis && req.groupId && req.sessionHash) {
    const cachedAccountId = await getSessionSticky(
      redis,
      req.groupId,
      req.sessionHash,
    );
    if (cachedAccountId && !excluded.has(cachedAccountId)) {
      const account = await loadSchedulableAccount(db, cachedAccountId, {
        ...req,
        groupId: req.groupId,
      });
      if (account) {
        await setSessionSticky(redis, req.groupId, req.sessionHash, account.id);
        return {
          account,
          decision: {
            layer: "session_hash",
            stickyHit: true,
            candidateCount: 1,
            selectedAccountId: account.id,
            selectedAccountType: account.type,
            loadSkew: 0,
          },
          release: noopRelease,
        };
      }
    }
  }

  // Layer 3 — load balance
  const candidates = await listSchedulableCandidates(db, req, excluded);
  if (candidates.length === 0) {
    throw new NoSchedulableAccountsError(req.orgId, req.groupId, excluded.size);
  }

  const scored = candidates.map((c) => {
    // Lower DB priority number = higher preference; invert so 1 → 1.0, 100 → 0.01.
    const basePriority = 1 / Math.max(c.priority, 1);
    const weight = stats.weightedScore(c.id, basePriority);
    return { account: c, weight };
  });

  let selectedAccount: CandidateRow;

  if (req.groupId) {
    // Group scope — weighted-random top-K across the group's members so
    // load distributes across roughly-equivalent accounts. EWMA stats are
    // the load signal.
    scored.sort((a, b) => b.weight - a.weight);
    const top = scored.slice(0, Math.max(1, topK));
    const totalWeight = top.reduce((sum, s) => sum + s.weight, 0);
    selectedAccount = top[0]!.account;
    if (totalWeight > 0) {
      const r = random() * totalWeight;
      let acc = 0;
      for (const s of top) {
        acc += s.weight;
        if (r <= acc) {
          selectedAccount = s.account;
          break;
        }
      }
    }
  } else {
    // Legacy org/team scope — preserve 4A's deterministic ladder semantic:
    // team-scoped accounts first, then ORDER BY priority asc, lastUsedAt asc.
    // The candidate list is already sorted; take the head.
    selectedAccount = candidates[0]!;
  }

  // Bind sticky on first miss so subsequent requests with the same hash land
  // on the same account (Layer 2 contract).
  if (redis && req.groupId && req.sessionHash) {
    await setSessionSticky(
      redis,
      req.groupId,
      req.sessionHash,
      selectedAccount.id,
    );
  }
  if (redis && req.groupId && req.previousResponseId) {
    await setRespSticky(
      redis,
      req.groupId,
      req.previousResponseId,
      selectedAccount.id,
    );
  }

  const loadSkew = computeLoadSkew(scored.map((s) => s.weight));

  return {
    account: selectedAccount,
    decision: {
      layer: "load_balance",
      stickyHit: false,
      candidateCount: candidates.length,
      selectedAccountId: selectedAccount.id,
      selectedAccountType: selectedAccount.type,
      loadSkew,
    },
    release: noopRelease,
  };
}

const noopRelease = async () => {};

function computeLoadSkew(weights: readonly number[]): number {
  if (weights.length === 0) return 0;
  const max = Math.max(...weights);
  const min = Math.min(...weights);
  const mean = weights.reduce((a, b) => a + b, 0) / weights.length;
  if (mean === 0) return 0;
  return (max - min) / mean;
}

interface CandidateRow {
  id: string;
  concurrency: number;
  platform: string;
  type: string;
  priority: number;
  groupId: string | null;
}

async function listSchedulableCandidates(
  db: Database,
  req: ScheduleRequest,
  excluded: ReadonlySet<string>,
): Promise<CandidateRow[]> {
  const nowDate = new Date();
  const baseConditions = [
    eq(upstreamAccounts.orgId, req.orgId),
    isNull(upstreamAccounts.deletedAt),
    eq(upstreamAccounts.schedulable, true),
    eq(upstreamAccounts.status, "active"),
    or(
      isNull(upstreamAccounts.rateLimitedAt),
      lt(upstreamAccounts.rateLimitResetAt, nowDate),
    ),
    or(
      isNull(upstreamAccounts.overloadUntil),
      lt(upstreamAccounts.overloadUntil, nowDate),
    ),
    or(
      isNull(upstreamAccounts.tempUnschedulableUntil),
      lt(upstreamAccounts.tempUnschedulableUntil, nowDate),
    ),
  ] as Parameters<typeof and>;

  if (excluded.size > 0) {
    baseConditions.push(notInArray(upstreamAccounts.id, [...excluded]));
  }

  if (req.groupId) {
    // Group-based selection: join via account_group_members; the account's
    // priority within the group overrides the row-level priority.
    const rows = await db
      .select({
        id: upstreamAccounts.id,
        concurrency: upstreamAccounts.concurrency,
        platform: upstreamAccounts.platform,
        type: upstreamAccounts.type,
        rowPriority: upstreamAccounts.priority,
        groupId: accountGroupMembers.groupId,
        groupPriority: accountGroupMembers.priority,
        groupPlatform: accountGroups.platform,
        groupStatus: accountGroups.status,
        groupDeletedAt: accountGroups.deletedAt,
      })
      .from(upstreamAccounts)
      .innerJoin(
        accountGroupMembers,
        eq(accountGroupMembers.accountId, upstreamAccounts.id),
      )
      .innerJoin(
        accountGroups,
        eq(accountGroups.id, accountGroupMembers.groupId),
      )
      .where(
        and(
          eq(accountGroupMembers.groupId, req.groupId),
          eq(accountGroups.status, "active"),
          isNull(accountGroups.deletedAt),
          ...(baseConditions as unknown as Parameters<typeof and>),
        ),
      );

    return rows.map((r) => ({
      id: r.id,
      concurrency: r.concurrency,
      platform: r.platform,
      type: r.type,
      // Group-level priority overrides per-account row priority — matches
      // sub2api semantics where groups carry their own priority ladder.
      priority: r.groupPriority ?? r.rowPriority,
      groupId: r.groupId,
    }));
  }

  // Legacy org/team selection (no group). Mirrors selectAccount.ts shape so
  // existing failoverLoop callsites keep their semantics.
  const teamPredicate = req.teamId
    ? or(
        eq(upstreamAccounts.teamId, req.teamId),
        isNull(upstreamAccounts.teamId),
      )
    : isNull(upstreamAccounts.teamId);

  const rows = await db
    .select({
      id: upstreamAccounts.id,
      concurrency: upstreamAccounts.concurrency,
      platform: upstreamAccounts.platform,
      type: upstreamAccounts.type,
      priority: upstreamAccounts.priority,
    })
    .from(upstreamAccounts)
    .where(
      and(
        teamPredicate,
        ...(baseConditions as unknown as Parameters<typeof and>),
      ),
    )
    .orderBy(
      // Mirror selectAccount.ts: team-scoped (teamId IS NOT NULL) before
      // org-level, then priority asc, then NULLS-FIRST lastUsedAt.
      sql`(${upstreamAccounts.teamId} IS NULL) ASC`,
      asc(upstreamAccounts.priority),
      sql`${upstreamAccounts.lastUsedAt} ASC NULLS FIRST`,
    );

  return rows.map((r) => ({
    id: r.id,
    concurrency: r.concurrency,
    platform: r.platform,
    type: r.type,
    priority: r.priority,
    groupId: null,
  }));
}

async function loadSchedulableAccount(
  db: Database,
  accountId: string,
  req: ScheduleRequest,
): Promise<ScheduledAccount | null> {
  const nowDate = new Date();
  const conditions = [
    eq(upstreamAccounts.id, accountId),
    eq(upstreamAccounts.orgId, req.orgId),
    isNull(upstreamAccounts.deletedAt),
    eq(upstreamAccounts.schedulable, true),
    eq(upstreamAccounts.status, "active"),
    or(
      isNull(upstreamAccounts.rateLimitedAt),
      lt(upstreamAccounts.rateLimitResetAt, nowDate),
    ),
    or(
      isNull(upstreamAccounts.overloadUntil),
      lt(upstreamAccounts.overloadUntil, nowDate),
    ),
    or(
      isNull(upstreamAccounts.tempUnschedulableUntil),
      lt(upstreamAccounts.tempUnschedulableUntil, nowDate),
    ),
  ] as Parameters<typeof and>;

  if (req.groupId) {
    // Validate membership in the requested group.
    const rows = await db
      .select({
        id: upstreamAccounts.id,
        concurrency: upstreamAccounts.concurrency,
        platform: upstreamAccounts.platform,
        type: upstreamAccounts.type,
        priority: upstreamAccounts.priority,
        groupId: accountGroupMembers.groupId,
      })
      .from(upstreamAccounts)
      .innerJoin(
        accountGroupMembers,
        eq(accountGroupMembers.accountId, upstreamAccounts.id),
      )
      .where(
        and(
          eq(accountGroupMembers.groupId, req.groupId),
          ...(conditions as unknown as Parameters<typeof and>),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      concurrency: row.concurrency,
      platform: row.platform,
      type: row.type,
      priority: row.priority,
      groupId: row.groupId,
    };
  }

  const rows = await db
    .select({
      id: upstreamAccounts.id,
      concurrency: upstreamAccounts.concurrency,
      platform: upstreamAccounts.platform,
      type: upstreamAccounts.type,
      priority: upstreamAccounts.priority,
    })
    .from(upstreamAccounts)
    .where(and(...(conditions as unknown as Parameters<typeof and>)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    concurrency: row.concurrency,
    platform: row.platform,
    type: row.type,
    priority: row.priority,
    groupId: null,
  };
}

export { AccountRuntimeStats } from "./runtimeStats.js";

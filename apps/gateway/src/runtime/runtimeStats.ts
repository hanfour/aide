// Per-account runtime stats tracker (Plan 5A Part 7, Task 7.2).
//
// Tracks rolling error rate + first-token latency (TTFT) using EWMA, so
// the scheduler can score accounts in Layer 3 load_balance without paying
// a database lookup per scheduling decision. Pure in-memory; one instance
// per gateway process. State decays toward freshness via the smoothing
// factor (alpha) — accounts that go quiet drift back to neutral over time
// only when they receive new observations.

const DEFAULT_ALPHA = 0.2;
const TTFT_FLOOR_MS = 100;

export interface AccountStat {
  errorRate: number; // 0..1, EWMA of (success ? 0 : 1)
  ttftMs: number; // NaN when never observed
  lastUpdate: number; // epoch ms
}

const NEUTRAL_STAT = (): AccountStat => ({
  errorRate: 0,
  ttftMs: Number.NaN,
  lastUpdate: 0,
});

export interface AccountRuntimeStatsOptions {
  /** Smoothing factor in [0,1]; higher = more reactive to latest. */
  alpha?: number;
  /** Floor applied when scoring 1/ttft so cold accounts (NaN) don't dominate. */
  ttftFloorMs?: number;
}

/**
 * Map-based EWMA tracker. Methods return immutable snapshots; the internal
 * Map is replaced wholesale on each `record` to keep external readers (e.g.
 * `snapshot()`) safe to iterate while updates land.
 */
export class AccountRuntimeStats {
  private accounts = new Map<string, AccountStat>();
  private readonly alpha: number;
  private readonly ttftFloorMs: number;

  constructor(opts: AccountRuntimeStatsOptions = {}) {
    this.alpha = opts.alpha ?? DEFAULT_ALPHA;
    this.ttftFloorMs = opts.ttftFloorMs ?? TTFT_FLOOR_MS;
  }

  record(
    accountId: string,
    success: boolean,
    firstTokenMs?: number,
    nowMs: number = Date.now(),
  ): void {
    const prev = this.accounts.get(accountId) ?? NEUTRAL_STAT();
    const a = this.alpha;
    const errorObservation = success ? 0 : 1;
    const errorRate = a * errorObservation + (1 - a) * prev.errorRate;
    const ttftMs =
      firstTokenMs === undefined
        ? prev.ttftMs
        : Number.isNaN(prev.ttftMs)
          ? firstTokenMs
          : a * firstTokenMs + (1 - a) * prev.ttftMs;
    const next: AccountStat = {
      errorRate,
      ttftMs,
      lastUpdate: nowMs,
    };
    this.accounts.set(accountId, next);
  }

  /**
   * Returns the most recent observation for `accountId`, or a neutral stat
   * if the account has never been observed (ttftMs = NaN, errorRate = 0).
   */
  score(accountId: string): AccountStat {
    return this.accounts.get(accountId) ?? NEUTRAL_STAT();
  }

  /**
   * Composite weighted score used by Layer 3:
   *
   *     basePriority * (1 - errorRate) * (1 / max(ttft, ttftFloor))
   *
   * Cold accounts (ttft=NaN) use the floor — equivalent to "treat as fast
   * until proven slow" so newly-added accounts can earn traffic.
   *
   * Higher-priority numbers in the DB column mean lower preference (1 = top
   * priority). Callers should pass `1 / dbPriority` (or equivalent inversion)
   * as `basePriority`. We don't invert here so the helper stays purely
   * arithmetic and unit-testable without the DB convention.
   */
  weightedScore(accountId: string, basePriority: number): number {
    const stat = this.score(accountId);
    const ttft = Number.isNaN(stat.ttftMs)
      ? this.ttftFloorMs
      : Math.max(stat.ttftMs, this.ttftFloorMs);
    const reliability = Math.max(0, 1 - stat.errorRate);
    return basePriority * reliability * (1 / ttft);
  }

  /**
   * Iteration snapshot for metrics emission. Returns a fresh array so
   * callers can iterate without locking against concurrent updates.
   */
  snapshot(): Array<{ accountId: string; stat: AccountStat }> {
    return [...this.accounts.entries()].map(([accountId, stat]) => ({
      accountId,
      stat: { ...stat },
    }));
  }

  /** Number of accounts with at least one observation. */
  size(): number {
    return this.accounts.size;
  }

  /** Drop tracking for an account (e.g. after deletion). */
  forget(accountId: string): void {
    this.accounts.delete(accountId);
  }
}

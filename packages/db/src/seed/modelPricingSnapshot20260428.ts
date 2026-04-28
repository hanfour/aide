/**
 * Model pricing snapshot — 2026-04-28 (effective_from)
 *
 * Sources (verify at PR review against provider pricing pages):
 *   - Anthropic: https://www.anthropic.com/pricing
 *     Prompt-cache 5min vs 1h pricing per
 *     https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 *   - OpenAI: https://openai.com/api/pricing/
 *     Cached input pricing per OpenAI prompt-caching docs.
 *
 * Units: micros per million tokens (1 USD = 1_000_000 micros).
 *   $3 per 1M tokens → 3_000_000 micros per million tokens.
 *
 * Future price changes ship as a new migration:
 *   - INSERT a new row with `effective_from = <change date>`.
 *   - UPDATE the previous row's `effective_to = <change date>`.
 *
 * The seed in migration 0009 mirrors this table verbatim. Keeping the
 * canonical numbers in TS too lets future tooling (admin UI, scripts) read
 * them without round-tripping through the DB.
 */
export interface ModelPricingSeedRow {
  platform: "anthropic" | "openai" | "gemini" | "antigravity";
  modelId: string;
  inputPerMillionMicros: bigint;
  outputPerMillionMicros: bigint;
  cached5mPerMillionMicros: bigint | null;
  cached1hPerMillionMicros: bigint | null;
  /**
   * Anthropic prompt-cache READ pricing.  ~10% of input rate per
   * Anthropic docs.  NULL for OpenAI rows (OpenAI uses cached_input).
   * Added by migration 0011.
   */
  cacheReadPerMillionMicros: bigint | null;
  cachedInputPerMillionMicros: bigint | null;
  effectiveFrom: string;
}

export const MODEL_PRICING_SNAPSHOT_2026_04_28: readonly ModelPricingSeedRow[] =
  [
    // Anthropic — 5m / 1h cache pricing per Anthropic prompt-cache docs.
    {
      platform: "anthropic",
      modelId: "claude-opus-4-7",
      inputPerMillionMicros: 15_000_000n,
      outputPerMillionMicros: 75_000_000n,
      cached5mPerMillionMicros: 18_750_000n,
      cached1hPerMillionMicros: 30_000_000n,
      cacheReadPerMillionMicros: 1_500_000n, // $1.50/M = 10% of $15/M input
      cachedInputPerMillionMicros: null,
      effectiveFrom: "2026-04-28T00:00:00Z",
    },
    {
      platform: "anthropic",
      modelId: "claude-sonnet-4-6",
      inputPerMillionMicros: 3_000_000n,
      outputPerMillionMicros: 15_000_000n,
      cached5mPerMillionMicros: 3_750_000n,
      cached1hPerMillionMicros: 6_000_000n,
      cacheReadPerMillionMicros: 300_000n, // $0.30/M = 10% of $3/M input
      cachedInputPerMillionMicros: null,
      effectiveFrom: "2026-04-28T00:00:00Z",
    },
    {
      platform: "anthropic",
      modelId: "claude-haiku-4-5",
      inputPerMillionMicros: 1_000_000n,
      outputPerMillionMicros: 5_000_000n,
      cached5mPerMillionMicros: 1_250_000n,
      cached1hPerMillionMicros: 2_000_000n,
      cacheReadPerMillionMicros: 100_000n, // $0.10/M = 10% of $1/M input
      cachedInputPerMillionMicros: null,
      effectiveFrom: "2026-04-28T00:00:00Z",
    },
    // OpenAI — cached_input only; no 5m/1h split.
    {
      platform: "openai",
      modelId: "gpt-4o",
      inputPerMillionMicros: 2_500_000n,
      outputPerMillionMicros: 10_000_000n,
      cached5mPerMillionMicros: null,
      cached1hPerMillionMicros: null,
      cacheReadPerMillionMicros: null,
      cachedInputPerMillionMicros: 1_250_000n,
      effectiveFrom: "2026-04-28T00:00:00Z",
    },
    {
      platform: "openai",
      modelId: "gpt-4o-mini",
      inputPerMillionMicros: 150_000n,
      outputPerMillionMicros: 600_000n,
      cached5mPerMillionMicros: null,
      cached1hPerMillionMicros: null,
      cacheReadPerMillionMicros: null,
      cachedInputPerMillionMicros: 75_000n,
      effectiveFrom: "2026-04-28T00:00:00Z",
    },
    {
      platform: "openai",
      modelId: "o1",
      inputPerMillionMicros: 15_000_000n,
      outputPerMillionMicros: 60_000_000n,
      cached5mPerMillionMicros: null,
      cached1hPerMillionMicros: null,
      cacheReadPerMillionMicros: null,
      cachedInputPerMillionMicros: 7_500_000n,
      effectiveFrom: "2026-04-28T00:00:00Z",
    },
    {
      platform: "openai",
      modelId: "o1-mini",
      inputPerMillionMicros: 3_000_000n,
      outputPerMillionMicros: 12_000_000n,
      cached5mPerMillionMicros: null,
      cached1hPerMillionMicros: null,
      cacheReadPerMillionMicros: null,
      cachedInputPerMillionMicros: 1_500_000n,
      effectiveFrom: "2026-04-28T00:00:00Z",
    },
  ] as const;

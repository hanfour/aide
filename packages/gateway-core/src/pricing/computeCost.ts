// Plan 5A §11.2 — pure cost compute over a single ModelPricingRow.
// All intermediate arithmetic is in bigint micros to avoid float drift; the
// returned dollar values are derived once at the boundary (Number(x) /
// 1_000_000). Callers that need persistence-grade precision should keep the
// original bigint values; the dollar fields here are for ledger/UI display.

const MICROS_PER_MILLION = 1_000_000n;
const MICROS_PER_DOLLAR = 1_000_000;

export interface ModelPricingRow {
  inputPerMillionMicros: bigint;
  outputPerMillionMicros: bigint;
  /** Anthropic 5-minute prompt cache. NULL on non-Anthropic platforms. */
  cached5mPerMillionMicros: bigint | null;
  /** Anthropic 1-hour prompt cache. NULL on non-Anthropic platforms. */
  cached1hPerMillionMicros: bigint | null;
  /** OpenAI cached input. NULL on non-OpenAI platforms. */
  cachedInputPerMillionMicros: bigint | null;
}

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt-cache write (5-minute TTL). */
  cacheCreation5mTokens?: number;
  /** Anthropic prompt-cache write (1-hour TTL). */
  cacheCreation1hTokens?: number;
  /** Anthropic prompt-cache read — billed at the regular input rate. */
  cacheReadTokens?: number;
  /** OpenAI cached input. */
  cachedInputTokens?: number;
}

export interface ComputedCostBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  cachedInput: number;
}

export interface ComputedCost {
  totalCost: number;
  breakdown: ComputedCostBreakdown;
}

/**
 * Compute the dollar cost of a single LLM call given its pricing row and
 * token usage. Behaviour:
 *
 *   - `inputTokens` is the *total* prompt size; cache-classified tokens
 *     (5m / 1h / read / cached_input) are subtracted before charging at the
 *     regular input rate so each token is billed exactly once.
 *   - Anthropic and OpenAI never both populate cache fields; non-applicable
 *     fields go through as NULL and contribute 0.
 *   - `cacheReadTokens` is billed at `inputPerMillionMicros` (Anthropic
 *     reads = uncached input rate).
 *   - All math is in bigint micros; the dollar values are produced at the
 *     boundary by `Number(micros) / 1_000_000`.
 */
export function computeCost(
  pricing: ModelPricingRow,
  usage: UsageBreakdown,
): ComputedCost {
  const cache5mTokens = BigInt(usage.cacheCreation5mTokens ?? 0);
  const cache1hTokens = BigInt(usage.cacheCreation1hTokens ?? 0);
  const cacheReadTokens = BigInt(usage.cacheReadTokens ?? 0);
  const cachedInputTokens = BigInt(usage.cachedInputTokens ?? 0);

  const cache5mMicros =
    pricing.cached5mPerMillionMicros !== null
      ? (cache5mTokens * pricing.cached5mPerMillionMicros) / MICROS_PER_MILLION
      : 0n;

  const cache1hMicros =
    pricing.cached1hPerMillionMicros !== null
      ? (cache1hTokens * pricing.cached1hPerMillionMicros) / MICROS_PER_MILLION
      : 0n;

  const cacheReadMicros =
    (cacheReadTokens * pricing.inputPerMillionMicros) / MICROS_PER_MILLION;

  const cachedInputMicros =
    pricing.cachedInputPerMillionMicros !== null
      ? (cachedInputTokens * pricing.cachedInputPerMillionMicros) /
        MICROS_PER_MILLION
      : 0n;

  const cacheClassifiedTokens =
    (usage.cacheCreation5mTokens ?? 0) +
    (usage.cacheCreation1hTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cachedInputTokens ?? 0);
  const billableInputTokens = Math.max(
    0,
    usage.inputTokens - cacheClassifiedTokens,
  );

  const inputMicros =
    (BigInt(billableInputTokens) * pricing.inputPerMillionMicros) /
    MICROS_PER_MILLION;
  const outputMicros =
    (BigInt(usage.outputTokens) * pricing.outputPerMillionMicros) /
    MICROS_PER_MILLION;

  const totalMicros =
    inputMicros +
    outputMicros +
    cache5mMicros +
    cache1hMicros +
    cacheReadMicros +
    cachedInputMicros;

  return {
    totalCost: Number(totalMicros) / MICROS_PER_DOLLAR,
    breakdown: {
      input: Number(inputMicros) / MICROS_PER_DOLLAR,
      output: Number(outputMicros) / MICROS_PER_DOLLAR,
      cacheCreation: Number(cache5mMicros + cache1hMicros) / MICROS_PER_DOLLAR,
      cacheRead: Number(cacheReadMicros) / MICROS_PER_DOLLAR,
      cachedInput: Number(cachedInputMicros) / MICROS_PER_DOLLAR,
    },
  };
}

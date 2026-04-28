import { describe, it, expect } from "vitest";
import {
  computeCost,
  type ModelPricingRow,
} from "../src/pricing/computeCost.js";

// Plan 5A §11.2 — pure cost compute tests. No DB.
//
// All pricing rows are in micros per million tokens.
// 1_000_000 micros = $1, so $3/M tokens → 3_000_000 micros per million.

const ANTHROPIC_OPUS: ModelPricingRow = {
  inputPerMillionMicros: 15_000_000n,
  outputPerMillionMicros: 75_000_000n,
  cached5mPerMillionMicros: 18_750_000n,
  cached1hPerMillionMicros: 30_000_000n,
  cacheReadPerMillionMicros: 1_500_000n, // $1.50/M, ~10% of $15/M input
  cachedInputPerMillionMicros: null,
};

const OPENAI_GPT4O: ModelPricingRow = {
  inputPerMillionMicros: 2_500_000n,
  outputPerMillionMicros: 10_000_000n,
  cached5mPerMillionMicros: null,
  cached1hPerMillionMicros: null,
  cacheReadPerMillionMicros: null,
  cachedInputPerMillionMicros: 1_250_000n,
};

/**
 * Pre-migration-0011 row shape: cache_read column missing → null.
 * computeCost should fall back to billing cache_read at the input rate
 * (the original Plan 5A §11.2 behaviour, preserved for backwards
 * compatibility with rows that haven't been backfilled yet).
 */
const ANTHROPIC_LEGACY_NO_CACHE_READ: ModelPricingRow = {
  inputPerMillionMicros: 15_000_000n,
  outputPerMillionMicros: 75_000_000n,
  cached5mPerMillionMicros: 18_750_000n,
  cached1hPerMillionMicros: 30_000_000n,
  cacheReadPerMillionMicros: null,
  cachedInputPerMillionMicros: null,
};

describe("computeCost", () => {
  it("computes input + output cost when no cache fields are populated", () => {
    const result = computeCost(ANTHROPIC_OPUS, {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    // 1M tokens × $15/M = $15 input; 500K × $75/M = $37.50 output → $52.50
    expect(result.totalCost).toBeCloseTo(52.5, 6);
    expect(result.breakdown.input).toBeCloseTo(15, 6);
    expect(result.breakdown.output).toBeCloseTo(37.5, 6);
    expect(result.breakdown.cacheCreation).toBe(0);
    expect(result.breakdown.cacheRead).toBe(0);
    expect(result.breakdown.cachedInput).toBe(0);
  });

  it("subtracts cache-classified tokens from billable input so each token is billed once", () => {
    // inputTokens=1_000_000 includes 200K cache-creation 5m + 100K cache-read.
    // Billable input = 1M - 200K - 100K = 700K → 700K × $15/M = $10.50
    // Cache 5m: 200K × $18.75/M = $3.75
    // Cache read: 100K × $1.50/M (dedicated cache_read rate, post-0011) = $0.15
    // Output: 0
    // Total: $14.40
    const result = computeCost(ANTHROPIC_OPUS, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreation5mTokens: 200_000,
      cacheReadTokens: 100_000,
    });
    expect(result.breakdown.input).toBeCloseTo(10.5, 6);
    expect(result.breakdown.cacheCreation).toBeCloseTo(3.75, 6);
    expect(result.breakdown.cacheRead).toBeCloseTo(0.15, 6);
    expect(result.totalCost).toBeCloseTo(14.4, 6);
  });

  it("falls back to input rate for cache_read when cacheReadPerMillionMicros is NULL (pre-0011 row shape)", async () => {
    // Pre-migration-0011 rows have NULL cache_read; computeCost must
    // continue to bill them at the input rate so historical pricing
    // queries (e.g. cost replay against an old `effective_from` date)
    // produce the same numbers as the original Plan 5A §11.2 contract.
    // Same usage as the prior test, against a row WITHOUT the dedicated
    // rate; cache_read should bill at $15/M instead of $1.50/M.
    const result = computeCost(ANTHROPIC_LEGACY_NO_CACHE_READ, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreation5mTokens: 200_000,
      cacheReadTokens: 100_000,
    });
    expect(result.breakdown.input).toBeCloseTo(10.5, 6);
    expect(result.breakdown.cacheCreation).toBeCloseTo(3.75, 6);
    expect(result.breakdown.cacheRead).toBeCloseTo(1.5, 6); // input rate
    expect(result.totalCost).toBeCloseTo(15.75, 6);
  });

  it("clamps billable input to 0 when cache-classified tokens exceed inputTokens", () => {
    // Defensive: malformed usage where cache fields > inputTokens. Should
    // not produce negative billable input.
    const result = computeCost(ANTHROPIC_OPUS, {
      inputTokens: 100,
      outputTokens: 0,
      cacheCreation5mTokens: 200,
    });
    expect(result.breakdown.input).toBe(0);
    // 200 × $18.75/M = $0.00375
    expect(result.breakdown.cacheCreation).toBeCloseTo(0.00375, 8);
  });

  it("returns 0 for cache 5m/1h when pricing row has NULL (e.g. OpenAI)", () => {
    const result = computeCost(OPENAI_GPT4O, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreation5mTokens: 100_000, // populated but pricing is NULL
      cacheCreation1hTokens: 50_000,
    });
    expect(result.breakdown.cacheCreation).toBe(0);
    // billableInput = 1M - 100K - 50K = 850K × $2.5/M = $2.125
    expect(result.breakdown.input).toBeCloseTo(2.125, 6);
  });

  it("returns 0 for cachedInput when pricing row has NULL (e.g. Anthropic)", () => {
    const result = computeCost(ANTHROPIC_OPUS, {
      inputTokens: 100_000,
      outputTokens: 0,
      cachedInputTokens: 50_000, // populated but Anthropic pricing has NULL
    });
    expect(result.breakdown.cachedInput).toBe(0);
    // billableInput = 100K - 50K = 50K × $15/M = $0.75
    expect(result.breakdown.input).toBeCloseTo(0.75, 6);
  });

  it("OpenAI row with stray cacheReadTokens still bills at input rate (defensive)", () => {
    // OpenAI rows don't normally carry cacheReadTokens (it's an Anthropic
    // concept). If a caller passes them anyway, computeCost still bills
    // them at the regular input rate so no token escapes accounting.
    const result = computeCost(OPENAI_GPT4O, {
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 200,
    });
    // billable = 1000 - 200 = 800; 800 × $2.5/M = $0.002
    // cacheRead = 200 × $2.5/M = $0.0005 (input rate)
    expect(result.breakdown.input).toBeCloseTo(0.002, 8);
    expect(result.breakdown.cacheRead).toBeCloseTo(0.0005, 8);
    expect(result.breakdown.cacheCreation).toBe(0);
    expect(result.breakdown.cachedInput).toBe(0);
    expect(result.totalCost).toBeCloseTo(0.0025, 8);
  });

  it("computes OpenAI cached_input correctly", () => {
    // 100K cached × $1.25/M = $0.125; 200K billable input × $2.5/M = $0.50;
    // 50K output × $10/M = $0.50; total $1.125.
    const result = computeCost(OPENAI_GPT4O, {
      inputTokens: 300_000,
      outputTokens: 50_000,
      cachedInputTokens: 100_000,
    });
    expect(result.breakdown.cachedInput).toBeCloseTo(0.125, 6);
    expect(result.breakdown.input).toBeCloseTo(0.5, 6);
    expect(result.breakdown.output).toBeCloseTo(0.5, 6);
    expect(result.totalCost).toBeCloseTo(1.125, 6);
  });

  it("uses bigint internally — no float drift on awkward token counts", () => {
    // Anthropic Opus, 1234567 input × $15/M = $18.510405 exactly.
    const result = computeCost(ANTHROPIC_OPUS, {
      inputTokens: 1_234_567,
      outputTokens: 0,
    });
    // 1234567 × 15000000 / 1000000 = 18518505 micros = $18.518505
    expect(result.breakdown.input).toBeCloseTo(18.518505, 6);
  });

  it("treats undefined cache fields the same as 0", () => {
    const sparse = computeCost(ANTHROPIC_OPUS, {
      inputTokens: 1000,
      outputTokens: 100,
    });
    const explicit = computeCost(ANTHROPIC_OPUS, {
      inputTokens: 1000,
      outputTokens: 100,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      cachedInputTokens: 0,
    });
    expect(sparse).toEqual(explicit);
  });
});

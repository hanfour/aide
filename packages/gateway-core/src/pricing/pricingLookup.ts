import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { modelPricing, type Database } from "@aide/db";
import type { ModelPricingRow } from "./computeCost.js";

// Plan 5A §11.1 — DB-backed pricing lookup with in-process TTL cache.
//
// `effective_from <= at < effective_to` selects the active row. A NULL
// `effective_to` means "still in effect" (the open end). Cache entries are
// keyed by `(platform, modelId)`; a NULL cache entry encodes a confirmed
// miss so repeated unknown models don't re-query.
//
// NOTE: the cache key does NOT include `at`. In production `at` is always
// "now", so the active row is unambiguous and a single cache entry per
// model is correct. Callers that query different points in time within one
// process (tests, admin time-travel UIs) must call `invalidate()` between
// queries or accept the cached result for the first `at` they passed.

export type Platform = "anthropic" | "openai" | "gemini" | "antigravity";

export interface PricingLookup {
  lookup(
    platform: Platform,
    modelId: string,
    at: Date,
  ): Promise<ModelPricingRow | null>;
  /** Force the next lookup of `(platform, modelId)` to re-query the DB. */
  invalidate(platform: Platform, modelId: string): void;
  /** Test hook: drop all cached entries. */
  clearCache(): void;
}

export interface CreatePricingLookupOpts {
  /** TTL for cache entries in ms. Defaults to 5 minutes. */
  cacheTtlMs?: number;
  /** Test hook: inject a clock. Defaults to `Date.now`. */
  now?: () => number;
}

interface CacheEntry {
  row: ModelPricingRow | null;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const cacheKey = (platform: Platform, modelId: string): string =>
  `${platform}:${modelId}`;

export function createPricingLookup(
  db: Database,
  opts: CreatePricingLookupOpts = {},
): PricingLookup {
  const ttl = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  async function fetchFromDb(
    platform: Platform,
    modelId: string,
    at: Date,
  ): Promise<ModelPricingRow | null> {
    const rows = await db
      .select({
        inputPerMillionMicros: modelPricing.inputPerMillionMicros,
        outputPerMillionMicros: modelPricing.outputPerMillionMicros,
        cached5mPerMillionMicros: modelPricing.cached5mPerMillionMicros,
        cached1hPerMillionMicros: modelPricing.cached1hPerMillionMicros,
        cachedInputPerMillionMicros: modelPricing.cachedInputPerMillionMicros,
      })
      .from(modelPricing)
      .where(
        and(
          eq(modelPricing.platform, platform),
          eq(modelPricing.modelId, modelId),
          lte(modelPricing.effectiveFrom, at),
          or(
            isNull(modelPricing.effectiveTo),
            sql`${modelPricing.effectiveTo} > ${at}`,
          ),
        ),
      )
      .orderBy(desc(modelPricing.effectiveFrom))
      .limit(1);
    return rows[0] ?? null;
  }

  return {
    async lookup(platform, modelId, at) {
      const key = cacheKey(platform, modelId);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) {
        return cached.row;
      }
      const row = await fetchFromDb(platform, modelId, at);
      cache.set(key, { row, expiresAt: now() + ttl });
      return row;
    },
    invalidate(platform, modelId) {
      cache.delete(cacheKey(platform, modelId));
    },
    clearCache() {
      cache.clear();
    },
  };
}

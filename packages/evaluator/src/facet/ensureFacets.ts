/**
 * `ensureFacets` — batch caller wrapping `extractOne` (Plan 4C Phase 2 Part 15).
 *
 * Filters out sessions whose facet at `CURRENT_PROMPT_VERSION` already
 * exists, then runs `extractOne` for the remainder with bounded
 * concurrency. Pure-deps style — the gateway wires the concrete cache
 * reader and bound `extractOne`.
 */

import { CURRENT_PROMPT_VERSION } from "./promptBuilder.js";
import type { FacetSession } from "./extractor.js";

export interface EnsureFacetsDeps {
  /**
   * Resolve the existing facet row's promptVersion (or null if no row).
   */
  getFacet: (requestId: string) => Promise<{ promptVersion: number } | null>;

  /**
   * Run `extractOne` for one session.
   */
  extractOne: (session: FacetSession) => Promise<unknown>;

  /**
   * Maximum concurrent extractions. Tune to balance Anthropic rate limits
   * vs throughput. Default 5 in the gateway wiring.
   */
  concurrency: number;
}

export interface EnsureFacetsResult {
  extracted: number;
  cacheHits: number;
}

export async function ensureFacets(
  sessions: FacetSession[],
  deps: EnsureFacetsDeps,
): Promise<EnsureFacetsResult> {
  const needExtract: FacetSession[] = [];
  let cacheHits = 0;

  for (const s of sessions) {
    const existing = await deps.getFacet(s.requestId);
    if (existing && existing.promptVersion === CURRENT_PROMPT_VERSION) {
      cacheHits++;
      continue;
    }
    needExtract.push(s);
  }

  await parallelMap(needExtract, deps.concurrency, async (s) => {
    await deps.extractOne(s);
  });

  return { extracted: needExtract.length, cacheHits };
}

async function parallelMap<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let idx = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (idx < items.length) {
      const i = idx++;
      const item = items[i];
      if (item === undefined) break;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

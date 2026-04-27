import { describe, it, expect, vi } from "vitest";
import { ensureFacets } from "../../src/facet/ensureFacets";
import { CURRENT_PROMPT_VERSION } from "../../src/facet/promptBuilder";
import type { FacetSession } from "../../src/facet/extractor";

function makeSession(id: string): FacetSession {
  return {
    requestId: id,
    orgId: "org-1",
    turns: [{ role: "user", content: `hello from ${id}` }],
  };
}

describe("ensureFacets", () => {
  it("returns {extracted: 0, cacheHits: 0} for empty sessions", async () => {
    const getFacet = vi.fn().mockResolvedValue(null);
    const extractOne = vi.fn().mockResolvedValue(undefined);

    const out = await ensureFacets([], { getFacet, extractOne, concurrency: 5 });

    expect(out).toEqual({ extracted: 0, cacheHits: 0 });
    expect(getFacet).not.toHaveBeenCalled();
    expect(extractOne).not.toHaveBeenCalled();
  });

  it("counts every session as cache hit when all have current-version facet, never calls extractOne", async () => {
    const sessions = [makeSession("a"), makeSession("b"), makeSession("c")];
    const getFacet = vi
      .fn()
      .mockResolvedValue({ promptVersion: CURRENT_PROMPT_VERSION });
    const extractOne = vi.fn().mockResolvedValue(undefined);

    const out = await ensureFacets(sessions, {
      getFacet,
      extractOne,
      concurrency: 5,
    });

    expect(out).toEqual({ extracted: 0, cacheHits: 3 });
    expect(getFacet).toHaveBeenCalledTimes(3);
    expect(extractOne).not.toHaveBeenCalled();
  });

  it("only extracts sessions whose facet is missing or stale", async () => {
    const sessions = [
      makeSession("fresh-1"),
      makeSession("stale-1"),
      makeSession("missing-1"),
      makeSession("fresh-2"),
    ];
    // fresh-1, fresh-2 → current; stale-1 → older version; missing-1 → null
    const getFacet = vi.fn(async (id: string) => {
      if (id === "fresh-1" || id === "fresh-2") {
        return { promptVersion: CURRENT_PROMPT_VERSION };
      }
      if (id === "stale-1") {
        return { promptVersion: CURRENT_PROMPT_VERSION - 1 };
      }
      return null;
    });
    const extractOne = vi.fn().mockResolvedValue(undefined);

    const out = await ensureFacets(sessions, {
      getFacet,
      extractOne,
      concurrency: 5,
    });

    expect(out).toEqual({ extracted: 2, cacheHits: 2 });
    expect(extractOne).toHaveBeenCalledTimes(2);

    const extractedIds = extractOne.mock.calls.map(
      (c) => (c[0] as FacetSession).requestId,
    );
    expect(extractedIds.sort()).toEqual(["missing-1", "stale-1"]);
  });

  it("honours concurrency limit (max in-flight never exceeds limit)", async () => {
    const TOTAL = 20;
    const LIMIT = 4;
    const sessions = Array.from({ length: TOTAL }, (_, i) =>
      makeSession(`s-${i}`),
    );
    const getFacet = vi.fn().mockResolvedValue(null);

    let inFlight = 0;
    let maxInFlight = 0;
    const extractOne = vi.fn(async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // brief async tick so that the limiter actually sees concurrent waiters
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });

    const out = await ensureFacets(sessions, {
      getFacet,
      extractOne,
      concurrency: LIMIT,
    });

    expect(out).toEqual({ extracted: TOTAL, cacheHits: 0 });
    expect(extractOne).toHaveBeenCalledTimes(TOTAL);
    expect(maxInFlight).toBeLessThanOrEqual(LIMIT);
    // Sanity: did we actually run concurrently?
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("clamps concurrency to at least 1 when given 0", async () => {
    const sessions = [makeSession("a"), makeSession("b")];
    const getFacet = vi.fn().mockResolvedValue(null);
    const extractOne = vi.fn().mockResolvedValue(undefined);

    const out = await ensureFacets(sessions, {
      getFacet,
      extractOne,
      concurrency: 0,
    });

    expect(out).toEqual({ extracted: 2, cacheHits: 0 });
    expect(extractOne).toHaveBeenCalledTimes(2);
  });
});

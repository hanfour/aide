import type { Evidence, KeywordInput, SignalResult } from "./types.js";

const CONTEXT_CHARS = 80;

export function collectKeyword(input: KeywordInput): SignalResult {
  const { body, terms, caseSensitive = false, requestId } = input;
  if (!body || terms.length === 0)
    return { hit: false, value: 0, evidence: [] };

  const haystack = caseSensitive ? body : body.toLowerCase();
  const evidence: Evidence[] = [];

  for (const term of terms) {
    const needle = caseSensitive ? term : term.toLowerCase();
    let idx = 0;
    while (idx < haystack.length) {
      const found = haystack.indexOf(needle, idx);
      if (found === -1) break;
      const start = Math.max(0, found - CONTEXT_CHARS);
      const end = Math.min(body.length, found + needle.length + CONTEXT_CHARS);
      evidence.push({
        requestId,
        quote: body.slice(start, end),
        offset: found,
      });
      idx = found + needle.length;
    }
  }

  return {
    hit: evidence.length > 0,
    value: evidence.length,
    evidence,
  };
}

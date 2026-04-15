import type { EvalStandard } from "./types.js";

export function buildNoiseFilter(standard: EvalStandard): (text: string) => boolean {
  const prefixes = standard.noiseFilters?.prefixes ?? [];
  const phrases = standard.noiseFilters?.templatePhrases ?? [];
  const minLen = standard.noiseFilters?.minLength ?? 20;

  return (text: string): boolean => {
    const trimmed = text.trimStart();
    if (prefixes.some((p) => trimmed.startsWith(p))) return true;
    const lower = trimmed.toLowerCase();
    if (phrases.some((p) => lower.includes(p))) return true;
    if (trimmed.length < minLen) return true;
    return false;
  };
}

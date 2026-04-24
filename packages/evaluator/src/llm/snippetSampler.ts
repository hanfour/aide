import type { BodyRow } from "../signals/types.js";
import type { Snippet } from "./types.js";

const MAX_SNIPPETS = 20;
const EXCERPT_CAP = 1024;

export interface SampleInput {
  bodies: BodyRow[];
  capturedAtMap?: Map<string, string>; // requestId → ISO timestamp; caller provides
  seed?: number; // For deterministic random fill in tests
}

export function sampleSnippets(input: SampleInput): Snippet[] {
  const { bodies, capturedAtMap, seed } = input;
  const picks = new Map<string, Snippet>(); // requestId → snippet; dedupes

  // Phase 1: refusals
  for (const b of bodies) {
    if (picks.size >= MAX_SNIPPETS) break;
    if (b.stopReason === "refusal" && !picks.has(b.requestId)) {
      picks.set(b.requestId, buildSnippet(b, "refusal", capturedAtMap));
    }
  }

  // Phase 2: extended thinking
  for (const b of bodies) {
    if (picks.size >= MAX_SNIPPETS) break;
    if (hasThinking(b.requestParams) && !picks.has(b.requestId)) {
      picks.set(b.requestId, buildSnippet(b, "thinking", capturedAtMap));
    }
  }

  // Phase 3: session first + last
  const sessionGroups = groupBySession(bodies);
  for (const [, group] of sessionGroups) {
    if (picks.size >= MAX_SNIPPETS) break;
    const first = group[0];
    const last = group[group.length - 1];
    if (first !== undefined && !picks.has(first.requestId)) {
      picks.set(first.requestId, buildSnippet(first, "session_first", capturedAtMap));
    }
    if (
      last !== undefined &&
      last !== first &&
      picks.size < MAX_SNIPPETS &&
      !picks.has(last.requestId)
    ) {
      picks.set(last.requestId, buildSnippet(last, "session_last", capturedAtMap));
    }
  }

  // Phase 4: tool_use
  for (const b of bodies) {
    if (picks.size >= MAX_SNIPPETS) break;
    if (hasToolUse(b.responseBody) && !picks.has(b.requestId)) {
      picks.set(b.requestId, buildSnippet(b, "tool_use", capturedAtMap));
    }
  }

  // Phase 5: random fill (deterministic with seed)
  if (picks.size < MAX_SNIPPETS) {
    const remaining = bodies.filter((b) => !picks.has(b.requestId));
    const rng = mulberry32(seed ?? 0xc0ffee);
    shuffleInPlace(remaining, rng);
    for (const b of remaining) {
      if (picks.size >= MAX_SNIPPETS) break;
      picks.set(b.requestId, buildSnippet(b, "random", capturedAtMap));
    }
  }

  return Array.from(picks.values());
}

function buildSnippet(
  b: BodyRow,
  reason: Snippet["reason"],
  map?: Map<string, string>,
): Snippet {
  return {
    requestId: b.requestId,
    clientSessionId: b.clientSessionId,
    capturedAt: map?.get(b.requestId),
    reason,
    requestExcerpt: truncate(safeStringify(b.requestBody), EXCERPT_CAP),
    responseExcerpt: truncate(safeStringify(b.responseBody), EXCERPT_CAP),
  };
}

function hasThinking(params: unknown): boolean {
  if (typeof params !== "object" || params === null) return false;
  const p = params as Record<string, unknown>;
  const t = p.thinking;
  if (typeof t !== "object" || t === null) return false;
  const bt = (t as Record<string, unknown>).budget_tokens;
  return typeof bt === "number" && bt > 0;
}

function hasToolUse(responseBody: unknown): boolean {
  if (typeof responseBody !== "object" || responseBody === null) return false;
  const content = (responseBody as Record<string, unknown>).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      (c as Record<string, unknown>).type === "tool_use",
  );
}

function groupBySession(bodies: BodyRow[]): Map<string | null, BodyRow[]> {
  const m = new Map<string | null, BodyRow[]>();
  for (const b of bodies) {
    const arr = m.get(b.clientSessionId) ?? [];
    arr.push(b);
    m.set(b.clientSessionId, arr);
  }
  return m;
}

function safeStringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
}

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : s.slice(0, cap - 20) + "...[truncated]";
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

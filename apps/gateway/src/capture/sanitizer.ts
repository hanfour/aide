const SECRET_KEY_REGEX = /password|secret|token|api_key|bearer|cookie|authorization/i;
const MASKED = "***";

export function sanitize(input: unknown): unknown {
  return walk(input);
}

function walk(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(walk);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (SECRET_KEY_REGEX.test(key) && typeof value === "string") {
      out[key] = MASKED;
    } else {
      out[key] = walk(value);
    }
  }
  return out;
}

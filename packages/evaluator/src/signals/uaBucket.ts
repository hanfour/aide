export type UaBucket = "claude-code" | "cursor" | "raw-sdk" | "other";

export function bucketUserAgent(ua: string | null | undefined): UaBucket {
  if (!ua) return "other";
  const low = ua.toLowerCase();
  if (low.includes("claude-code")) return "claude-code";
  if (low.includes("cursor")) return "cursor";
  if (
    low.includes("anthropic-ai/sdk") ||
    low.includes("anthropic-sdk") ||
    low.includes("python-anthropic")
  ) {
    return "raw-sdk";
  }
  return "other";
}

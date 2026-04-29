// Generates a session hash used by the scheduler's Layer 2 sticky-session
// lookup (Plan 5A Part 7, Task 7.4). Mirrors sub2api's `GenerateSessionHash`
// in `internal/service/gateway_request.go`.
//
// Priority chain (highest first):
//   1. metadata.user_id matching `user_<hash>_account__session_<uuid>`
//      (Claude Code injects this; use the UUID directly so the sticky
//       binding survives across requests in the same Claude conversation).
//   2. SHA-256 hash of (system + messages) — content-based, stable for any
//      client that sends the same prompt history.
//   3. SHA-256 hash of messages alone — fallback for clients that omit
//      `system` or use only a user/assistant transcript.
//
// Returns `undefined` when none of the layers can produce a hash, which
// signals the scheduler to fall through to Layer 3 (load_balance).

import { createHash } from "node:crypto";

const CLAUDE_CODE_SESSION_PATTERN =
  /_session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export interface ParsedRequestForSessionHash {
  /** Anthropic / OpenAI-style messages array. */
  messages?: unknown;
  /** Optional Anthropic-style system prompt (string or array). */
  system?: unknown;
  /** Provider-specific metadata bag; we only read `user_id`. */
  metadata?: { user_id?: unknown } | null;
}

export function generateSessionHash(
  req: ParsedRequestForSessionHash,
): string | undefined {
  const userId =
    req.metadata && typeof req.metadata.user_id === "string"
      ? req.metadata.user_id
      : undefined;
  if (userId) {
    const m = userId.match(CLAUDE_CODE_SESSION_PATTERN);
    if (m && m[1]) {
      // Lowercase so callers don't double-bind on case-only differences.
      return `cc:${m[1].toLowerCase()}`;
    }
  }

  const messages = canonicalize(req.messages);
  if (messages) {
    const system = canonicalize(req.system);
    if (system) {
      return `cnt:${sha256(`${system}\n${messages}`)}`;
    }
    return `msg:${sha256(messages)}`;
  }

  return undefined;
}

function canonicalize(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  try {
    const json = JSON.stringify(value);
    return json && json !== "[]" && json !== "{}" ? json : undefined;
  } catch {
    return undefined;
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

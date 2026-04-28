import type { Platform, RefreshPolicy } from "./types.js";

// Plan 5A §7.2 / X4 — per-platform RefreshPolicy.
//
// The two tunables (`onRefreshError`, `onLockHeld`) are a function of how
// each provider's token endpoint behaves under load and how each CLI
// expects upstream failures to surface:
//
//   - **Anthropic / OpenAI** are tolerant: short-lived 5xx during refresh
//     are common, callers prefer to keep using the current access token
//     for up to 1 minute rather than fail.  Lock-held callers wait so
//     the subsequent fetch returns the freshly-refreshed token.
//
//   - **Gemini / Antigravity** are strict: their token endpoints are
//     reliable and Codex/CLI users expect immediate failure on refresh
//     errors so retries surface deterministically.  Lock-held callers
//     proceed with the existing token rather than wait.
//
// Source: sub2api `internal/service/refresh_policy.go` empirical defaults.

export const ANTHROPIC_REFRESH_POLICY: RefreshPolicy = {
  platform: "anthropic",
  onRefreshError: "use_existing_token",
  onLockHeld: "wait_for_cache",
  failureTTLMs: 60_000, // 1 min
};

export const OPENAI_REFRESH_POLICY: RefreshPolicy = {
  platform: "openai",
  onRefreshError: "use_existing_token",
  onLockHeld: "wait_for_cache",
  failureTTLMs: 60_000, // 1 min
};

export const GEMINI_REFRESH_POLICY: RefreshPolicy = {
  platform: "gemini",
  onRefreshError: "return_error",
  onLockHeld: "use_existing_token",
  failureTTLMs: 0,
};

export const ANTIGRAVITY_REFRESH_POLICY: RefreshPolicy = {
  platform: "antigravity",
  onRefreshError: "return_error",
  onLockHeld: "use_existing_token",
  failureTTLMs: 0,
};

const POLICIES: Record<Platform, RefreshPolicy> = {
  anthropic: ANTHROPIC_REFRESH_POLICY,
  openai: OPENAI_REFRESH_POLICY,
  gemini: GEMINI_REFRESH_POLICY,
  antigravity: ANTIGRAVITY_REFRESH_POLICY,
};

/**
 * Look up the RefreshPolicy for `platform`.  Throws if the platform is
 * unknown — every legitimate value of `Platform` is registered here, so
 * an unknown value indicates a programming error (e.g. a new platform
 * constant added without policy registration).
 */
export function getPolicy(platform: Platform): RefreshPolicy {
  const p = POLICIES[platform];
  if (!p) {
    throw new Error(`oauth_refresh_policy_not_registered: ${platform}`);
  }
  return p;
}

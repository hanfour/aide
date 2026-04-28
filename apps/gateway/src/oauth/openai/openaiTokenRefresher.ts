import {
  OAuthRefreshError,
  OAuthRefreshTokenInvalid,
  type TokenRefresher,
  type TokenSet,
} from "../types.js";
import { OPENAI_CODEX_OAUTH } from "./codexConstants.js";
import { parseTokenResponse } from "./openaiOAuthService.js";

// Plan 5A §6.5 — OpenAI Codex token refresher.  Implements the
// TokenRefresher interface for use by `OAuthRefreshAPI`.
//
// Rotation behaviour (decision A4): the OpenAI token endpoint MAY rotate
// the refresh_token on every refresh call.  When the response includes
// `refresh_token`, we adopt it as the new long-lived credential.  When
// it doesn't, we keep the old one — both cases produce a valid
// `TokenSet` and `OAuthRefreshAPI` writes it atomically via the vault
// CAS so an in-flight rotation can't be lost.
//
// Failure handling:
//   - HTTP 400 with `invalid_grant` in the body → throws
//     OAuthRefreshTokenInvalid (always propagates regardless of the
//     RefreshPolicy; account is marked oauth_invalid).  Most other 4xx
//     `error` codes from RFC 6749 are also non-retriable but
//     `invalid_grant` is the explicit "your refresh_token is dead"
//     signal we treat with the strictest semantics.
//   - Other 4xx / 5xx → OAuthRefreshError; the RefreshPolicy decides
//     whether to fall back to the cached access token (tolerant) or
//     bubble (strict).

const URLENCODED = "application/x-www-form-urlencoded";

export interface OpenAITokenRefresherDeps {
  /** Test hook — defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Test hook — defaults to `Date.now`. */
  now?: () => number;
}

export function createOpenAITokenRefresher(
  deps: OpenAITokenRefresherDeps = {},
): TokenRefresher {
  const httpFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;

  return {
    platform: "openai",

    async refresh(refreshToken) {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: OPENAI_CODEX_OAUTH.clientId,
        refresh_token: refreshToken,
        scope: OPENAI_CODEX_OAUTH.refreshScopes,
      });

      const res = await httpFetch(OPENAI_CODEX_OAUTH.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": URLENCODED },
        body,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (isInvalidGrant(res.status, text)) {
          throw new OAuthRefreshTokenInvalid(
            `openai_oauth_invalid_grant: ${truncate(text, 240)}`,
            "openai",
          );
        }
        throw new OAuthRefreshError(
          `openai_oauth_refresh_failed: http_${res.status}: ${truncate(text, 240)}`,
          "openai",
        );
      }

      const data = (await res.json()) as Record<string, unknown>;
      const parsed = parseTokenResponse(data, now);

      // Per A4: rotation is OPTIONAL — keep the existing refresh_token
      // when the response omits it.  parseTokenResponse already requires
      // the response to carry one (since we're a refresh call, OpenAI's
      // implementation always echoes the refresh_token), but defend
      // against future response shape changes.
      if (typeof data.refresh_token !== "string" || data.refresh_token.length === 0) {
        return { ...parsed, refreshToken } as TokenSet;
      }
      return parsed;
    },
  };
}

/**
 * RFC 6749 `invalid_grant` detection.  OpenAI's auth endpoint returns
 * either a JSON body `{ "error": "invalid_grant", ... }` or a plain-text
 * response containing the marker — we accept both.
 */
function isInvalidGrant(status: number, body: string): boolean {
  if (status !== 400 && status !== 401) return false;
  if (body.includes('"error":"invalid_grant"')) return true;
  if (body.includes('"error": "invalid_grant"')) return true;
  if (body.includes("invalid_grant")) return true;
  return false;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

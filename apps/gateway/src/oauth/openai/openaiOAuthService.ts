import {
  generateCodeChallenge,
  generatePKCEVerifier,
  generateState,
} from "../pkce.js";
import {
  OAuthRefreshError,
  type OAuthService,
  type TokenSet,
} from "../types.js";
import { OPENAI_CODEX_OAUTH } from "./codexConstants.js";

// Plan 5A §6 — interactive OAuth flow for OpenAI Codex CLI.  Implements
// the OAuthService interface (Part 4 types.ts).  Two operations:
//
//   - generateAuthURL: build the Codex authorize URL with PKCE S256
//     challenge + a fresh CSRF state token.  The caller persists `state`
//     and `codeVerifier` (e.g. in Redis-backed flow state) until the
//     user's browser redirects back with the auth code.
//   - exchangeCode: trade the authorization code for an initial TokenSet
//     against the Codex token endpoint.

const URLENCODED = "application/x-www-form-urlencoded";

export interface OpenAIOAuthServiceDeps {
  /** Test hook — defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Test hook — defaults to `Date.now`. */
  now?: () => number;
}

export function createOpenAIOAuthService(
  deps: OpenAIOAuthServiceDeps = {},
): OAuthService {
  const httpFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;

  return {
    platform: "openai",

    async generateAuthURL(opts) {
      const codeVerifier = generatePKCEVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateState();
      const redirectURI =
        opts.redirectURI ?? OPENAI_CODEX_OAUTH.defaultRedirectURI;

      const url = new URL(OPENAI_CODEX_OAUTH.authorizeEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", OPENAI_CODEX_OAUTH.clientId);
      url.searchParams.set("redirect_uri", redirectURI);
      url.searchParams.set("scope", OPENAI_CODEX_OAUTH.scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set(
        "code_challenge_method",
        OPENAI_CODEX_OAUTH.pkceMethod,
      );

      return { authUrl: url.toString(), state, codeVerifier };
    },

    async exchangeCode(opts) {
      const redirectURI =
        opts.redirectURI ?? OPENAI_CODEX_OAUTH.defaultRedirectURI;
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OPENAI_CODEX_OAUTH.clientId,
        code: opts.code,
        redirect_uri: redirectURI,
        code_verifier: opts.codeVerifier,
      });

      const res = await httpFetch(OPENAI_CODEX_OAUTH.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": URLENCODED },
        body,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new OAuthRefreshError(
          `openai_oauth_exchange_failed: http_${res.status}: ${truncate(text, 240)}`,
          "openai",
        );
      }

      const data = (await res.json()) as Record<string, unknown>;
      return parseTokenResponse(data, now);
    },
  };
}

/**
 * Pure parser for `application/json` token responses from
 * https://auth.openai.com/oauth/token.  Validates `access_token`,
 * `refresh_token`, `expires_in` (number, seconds) at minimum; accepts
 * an optional `token_type` (defaults "Bearer") and `scope`.
 */
export function parseTokenResponse(
  data: Record<string, unknown>,
  now: () => number,
): TokenSet {
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn = data.expires_in;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthRefreshError(
      "openai_oauth_token_response_missing_access_token",
      "openai",
    );
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new OAuthRefreshError(
      "openai_oauth_token_response_missing_refresh_token",
      "openai",
    );
  }
  if (typeof expiresIn !== "number" || expiresIn <= 0) {
    throw new OAuthRefreshError(
      "openai_oauth_token_response_invalid_expires_in",
      "openai",
    );
  }
  const tokenType =
    typeof data.token_type === "string" ? data.token_type : "Bearer";
  const scope = typeof data.scope === "string" ? data.scope : undefined;

  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(now() + expiresIn * 1000),
    tokenType,
    scope,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

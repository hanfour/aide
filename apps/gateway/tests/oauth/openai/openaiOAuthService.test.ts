import { describe, it, expect, vi } from "vitest";
import {
  createOpenAIOAuthService,
  parseTokenResponse,
} from "../../../src/oauth/openai/openaiOAuthService.js";
import { OPENAI_CODEX_OAUTH } from "../../../src/oauth/openai/codexConstants.js";
import { OAuthRefreshError } from "../../../src/oauth/types.js";

// Plan 5A §6 — interactive OAuth flow.  All HTTP calls are mocked via
// dependency injection; never reaches the real OpenAI auth endpoint.

function makeFakeFetch(
  responses: Array<{
    status: number;
    body: string | object;
    contentType?: string;
  }>,
) {
  let callIdx = 0;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const r = responses[callIdx++];
    if (!r) throw new Error("fakeFetch: no response queued");
    const bodyStr =
      typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(bodyStr, {
      status: r.status,
      headers: { "content-type": r.contentType ?? "application/json" },
    }) as Response;
  };
  return { fakeFetch, calls };
}

describe("openaiOAuthService.generateAuthURL", () => {
  it("includes all OAuth + PKCE params with the vendored client_id and S256 challenge method", async () => {
    const svc = createOpenAIOAuthService();
    const { authUrl, state, codeVerifier } = await svc.generateAuthURL({});
    const url = new URL(authUrl);

    expect(url.origin + url.pathname).toBe(
      OPENAI_CODEX_OAUTH.authorizeEndpoint,
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(OPENAI_CODEX_OAUTH.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(
      OPENAI_CODEX_OAUTH.defaultRedirectURI,
    );
    expect(url.searchParams.get("scope")).toBe(
      OPENAI_CODEX_OAUTH.scopes.join(" "),
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")?.length).toBeGreaterThan(40);
    expect(url.searchParams.get("state")).toBe(state);

    // PKCE verifier returned to caller is base64url, 43 chars (32 bytes).
    expect(codeVerifier.length).toBe(43);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("respects an explicit redirectURI override", async () => {
    const svc = createOpenAIOAuthService();
    const { authUrl } = await svc.generateAuthURL({
      redirectURI: "http://localhost:9999/cb",
    });
    expect(new URL(authUrl).searchParams.get("redirect_uri")).toBe(
      "http://localhost:9999/cb",
    );
  });

  it("two consecutive calls produce different state + codeVerifier (no caching)", async () => {
    const svc = createOpenAIOAuthService();
    const a = await svc.generateAuthURL({});
    const b = await svc.generateAuthURL({});
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe("openaiOAuthService.exchangeCode", () => {
  it("POSTs to the token endpoint with grant_type=authorization_code and returns a TokenSet", async () => {
    const fixedNow = 1_700_000_000_000;
    const { fakeFetch, calls } = makeFakeFetch([
      {
        status: 200,
        body: {
          access_token: "atk_initial",
          refresh_token: "rtk_initial",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile offline_access",
        },
      },
    ]);
    const svc = createOpenAIOAuthService({
      fetch: fakeFetch,
      now: () => fixedNow,
    });

    const result = await svc.exchangeCode({
      code: "auth-code-from-callback",
      codeVerifier: "verifier-43chars-padding-goes-here_____",
    });

    expect(result.accessToken).toBe("atk_initial");
    expect(result.refreshToken).toBe("rtk_initial");
    expect(result.tokenType).toBe("Bearer");
    expect(result.scope).toBe("openid email profile offline_access");
    expect(result.expiresAt.getTime()).toBe(fixedNow + 3600 * 1000);

    expect(calls.length).toBe(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(OPENAI_CODEX_OAUTH.tokenEndpoint);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const body = init?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe(OPENAI_CODEX_OAUTH.clientId);
    expect(body.get("code")).toBe("auth-code-from-callback");
    expect(body.get("redirect_uri")).toBe(
      OPENAI_CODEX_OAUTH.defaultRedirectURI,
    );
  });

  it("throws OAuthRefreshError on HTTP 4xx with the response body included", async () => {
    const { fakeFetch } = makeFakeFetch([
      {
        status: 400,
        body: '{"error":"invalid_request","error_description":"Code expired"}',
        contentType: "application/json",
      },
    ]);
    const svc = createOpenAIOAuthService({ fetch: fakeFetch });

    await expect(
      svc.exchangeCode({ code: "expired", codeVerifier: "v" }),
    ).rejects.toBeInstanceOf(OAuthRefreshError);
  });

  it("throws when the response is missing access_token / refresh_token / expires_in", async () => {
    const { fakeFetch } = makeFakeFetch([
      {
        status: 200,
        body: { access_token: "atk", refresh_token: "rtk" }, // missing expires_in
      },
    ]);
    const svc = createOpenAIOAuthService({ fetch: fakeFetch });
    await expect(
      svc.exchangeCode({ code: "c", codeVerifier: "v" }),
    ).rejects.toThrow(/openai_oauth_token_response_invalid_expires_in/);
  });
});

describe("parseTokenResponse", () => {
  it("defaults token_type to Bearer when absent", () => {
    const set = parseTokenResponse(
      { access_token: "a", refresh_token: "r", expires_in: 60 },
      () => 1000,
    );
    expect(set.tokenType).toBe("Bearer");
  });

  it("expiresAt is now() + expires_in × 1000", () => {
    const set = parseTokenResponse(
      { access_token: "a", refresh_token: "r", expires_in: 90 },
      () => 1_000_000,
    );
    expect(set.expiresAt.getTime()).toBe(1_000_000 + 90_000);
  });
});

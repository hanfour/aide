import { OAuthRefreshAPI } from "../refreshApi.js";
import type { TokenProvider } from "../types.js";

// Plan 5A — OpenAI TokenProvider.  Thin wrapper over `OAuthRefreshAPI`
// that the inference hot path imports for "give me a valid access token
// for this OpenAI OAuth account".  All caching / locking / refresh
// orchestration lives in OAuthRefreshAPI; this class just exists so the
// 4-piece DI surface is symmetric across platforms.

export interface OpenAITokenProviderDeps {
  refreshApi: OAuthRefreshAPI;
}

export function createOpenAITokenProvider(
  deps: OpenAITokenProviderDeps,
): TokenProvider {
  return {
    platform: "openai",
    async getAccessToken(accountId) {
      return deps.refreshApi.getValidAccessToken(accountId);
    },
    invalidate(accountId) {
      deps.refreshApi.invalidate(accountId);
    },
  };
}

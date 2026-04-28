import { describe, it, expect, vi } from "vitest";
import {
  registerOpenAIOAuth,
  createOpenAITokenProvider,
} from "../../../src/oauth/openai/index.js";
import {
  createOAuthRegistry,
  getOAuthService,
  getTokenProvider,
  getTokenRefresher,
} from "../../../src/oauth/registry.js";
import type { OAuthRefreshAPI } from "../../../src/oauth/refreshApi.js";

describe("registerOpenAIOAuth", () => {
  function makeStubRefreshApi(): OAuthRefreshAPI {
    return {
      getValidAccessToken: vi
        .fn()
        .mockResolvedValue({ accessToken: "stub-access" }),
      invalidate: vi.fn(),
      clearCache: vi.fn(),
    } as unknown as OAuthRefreshAPI;
  }

  it("populates services / refreshers / providers under the 'openai' key", () => {
    const registry = createOAuthRegistry();
    registerOpenAIOAuth(registry, { refreshApi: makeStubRefreshApi() });

    expect(registry.services.openai?.platform).toBe("openai");
    expect(registry.refreshers.openai?.platform).toBe("openai");
    expect(registry.providers.openai?.platform).toBe("openai");
  });

  it("getter helpers resolve the registered pieces (no other platform leaks)", () => {
    const registry = createOAuthRegistry();
    registerOpenAIOAuth(registry, { refreshApi: makeStubRefreshApi() });

    expect(getOAuthService(registry, "openai").platform).toBe("openai");
    expect(getTokenRefresher(registry, "openai").platform).toBe("openai");
    expect(getTokenProvider(registry, "openai").platform).toBe("openai");

    expect(() => getOAuthService(registry, "anthropic")).toThrow(
      /oauth_service_not_registered_for_platform: anthropic/,
    );
  });
});

describe("createOpenAITokenProvider", () => {
  it("getAccessToken delegates to OAuthRefreshAPI.getValidAccessToken", async () => {
    const refreshApi = {
      getValidAccessToken: vi
        .fn()
        .mockResolvedValue({ accessToken: "delegated" }),
      invalidate: vi.fn(),
      clearCache: vi.fn(),
    } as unknown as OAuthRefreshAPI;

    const provider = createOpenAITokenProvider({ refreshApi });
    const result = await provider.getAccessToken("acc-xyz");
    expect(result.accessToken).toBe("delegated");
    expect(refreshApi.getValidAccessToken).toHaveBeenCalledWith("acc-xyz");
  });

  it("invalidate delegates to OAuthRefreshAPI.invalidate", () => {
    const refreshApi = {
      getValidAccessToken: vi.fn(),
      invalidate: vi.fn(),
      clearCache: vi.fn(),
    } as unknown as OAuthRefreshAPI;

    const provider = createOpenAITokenProvider({ refreshApi });
    provider.invalidate("acc-xyz");
    expect(refreshApi.invalidate).toHaveBeenCalledWith("acc-xyz");
  });
});

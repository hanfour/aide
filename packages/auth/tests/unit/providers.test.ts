import { describe, it, expect } from "vitest";
import { buildProviders } from "../../src/providers";

describe("buildProviders", () => {
  it("returns exactly 2 configured providers (Google + GitHub)", () => {
    const providers = buildProviders({
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GITHUB_CLIENT_ID: "github-id",
      GITHUB_CLIENT_SECRET: "github-secret",
    });

    expect(providers).toHaveLength(2);
    // Each provider is an object — next-auth accepts either a function or an
    // already-configured provider object. We just verify truthiness.
    expect(providers[0]).toBeTruthy();
    expect(providers[1]).toBeTruthy();
  });
});

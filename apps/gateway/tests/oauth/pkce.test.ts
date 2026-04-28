import { describe, it, expect } from "vitest";
import {
  generatePKCEVerifier,
  generateCodeChallenge,
  generateState,
  sha256Base64Url,
} from "../../src/oauth/pkce.js";

describe("pkce", () => {
  it("generatePKCEVerifier returns 43-char URL-safe base64 (no padding)", () => {
    const v = generatePKCEVerifier();
    // 32 bytes → 43 base64url chars (no padding).
    expect(v.length).toBe(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v).not.toContain("+");
    expect(v).not.toContain("/");
    expect(v).not.toContain("=");
  });

  it("two consecutive verifiers are distinct (CSPRNG entropy sanity check)", () => {
    const a = generatePKCEVerifier();
    const b = generatePKCEVerifier();
    expect(a).not.toBe(b);
  });

  it("sha256Base64Url matches the RFC 7636 §A.4 example", () => {
    // RFC 7636 Appendix A "Code Verifier and Challenge Example":
    //   verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    //   challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    expect(
      sha256Base64Url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generateCodeChallenge is deterministic given the same verifier", () => {
    const v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const c1 = generateCodeChallenge(v);
    const c2 = generateCodeChallenge(v);
    expect(c1).toBe(c2);
    expect(c1).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generateState returns 22-char URL-safe base64 (16 random bytes)", () => {
    const s = generateState();
    expect(s.length).toBe(22);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("two consecutive states are distinct", () => {
    expect(generateState()).not.toBe(generateState());
  });
});

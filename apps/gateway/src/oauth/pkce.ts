import { createHash, randomBytes } from "node:crypto";

// Plan 5A §6.4 — PKCE (RFC 7636) helpers shared by every platform-specific
// `OAuthService`.  All platforms in scope use the S256 challenge method.

/**
 * Generate a fresh PKCE verifier — 32 bytes of CSPRNG entropy encoded as
 * base64url (no padding, URL-safe alphabet).  43-128 chars per RFC 7636
 * §4.1; 32 random bytes round-trip to 43 base64url chars.
 */
export function generatePKCEVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** Base64url-encoded SHA-256 of the input string (no padding, URL-safe). */
export function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/**
 * Derive the PKCE code_challenge for the S256 method per RFC 7636 §4.2:
 * `BASE64URL(SHA256(verifier))`.  Use this on `OAuthService.generateAuthURL`
 * and pass the verifier (not the challenge) to `exchangeCode`.
 */
export function generateCodeChallenge(verifier: string): string {
  return sha256Base64Url(verifier);
}

/** Generate a random base64url state token (16 bytes → 22 chars). */
export function generateState(): string {
  return randomBytes(16).toString("base64url");
}

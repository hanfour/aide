import { describe, it, expect, vi } from "vitest";
import { encryptCredential } from "@caliber/gateway-core";
import {
  resolveCredential,
  CredentialNotFoundError,
  CredentialFormatError,
} from "../../src/runtime/resolveCredential.js";

const masterKey = "a".repeat(64);
const accountId = "00000000-0000-0000-0000-000000000001";

function sealed(plaintext: string, cipherVersion: 1 | 2 = 2) {
  const s = encryptCredential({ masterKeyHex: masterKey, accountId, plaintext });
  return { nonce: s.nonce, ciphertext: s.ciphertext, authTag: s.authTag, cipherVersion };
}

function makeMockDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "from", "where", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  (chain["limit"] as ReturnType<typeof vi.fn>).mockReturnValue({
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
  });
  return chain as never;
}

describe("resolveCredential", () => {
  it("1. api_key happy path — returns typed api_key credential", async () => {
    const row = sealed(JSON.stringify({ type: "api_key", api_key: "sk-test" }));
    const db = makeMockDb([row]);
    const out = await resolveCredential(db, accountId, { masterKeyHex: masterKey });
    expect(out).toEqual({ type: "api_key", apiKey: "sk-test" });
  });

  it("2. oauth happy path — returns typed oauth credential with Date", async () => {
    const row = sealed(
      JSON.stringify({
        type: "oauth",
        access_token: "tok-access",
        refresh_token: "tok-refresh",
        expires_at: "2026-12-31T00:00:00Z",
      }),
    );
    const db = makeMockDb([row]);
    const out = await resolveCredential(db, accountId, { masterKeyHex: masterKey });
    expect(out).toEqual({
      type: "oauth",
      accessToken: "tok-access",
      refreshToken: "tok-refresh",
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    });
  });

  it("3. oauth with scope — returned object includes scope", async () => {
    const row = sealed(
      JSON.stringify({
        type: "oauth",
        access_token: "tok-access",
        refresh_token: "tok-refresh",
        expires_at: "2026-12-31T00:00:00Z",
        scope: "foo bar",
      }),
    );
    const db = makeMockDb([row]);
    const out = await resolveCredential(db, accountId, { masterKeyHex: masterKey });
    expect(out).toEqual({
      type: "oauth",
      accessToken: "tok-access",
      refreshToken: "tok-refresh",
      expiresAt: new Date("2026-12-31T00:00:00Z"),
      scope: "foo bar",
    });
  });

  it("4. CredentialNotFoundError when db returns empty array", async () => {
    const db = makeMockDb([]);
    await expect(
      resolveCredential(db, accountId, { masterKeyHex: masterKey }),
    ).rejects.toThrow(CredentialNotFoundError);
  });

  it("5. CredentialFormatError on malformed JSON", async () => {
    const row = sealed("not json");
    const db = makeMockDb([row]);
    await expect(
      resolveCredential(db, accountId, { masterKeyHex: masterKey }),
    ).rejects.toThrow(CredentialFormatError);
  });

  it("6. CredentialFormatError on empty api_key string", async () => {
    const row = sealed(JSON.stringify({ type: "api_key", api_key: "" }));
    const db = makeMockDb([row]);
    await expect(
      resolveCredential(db, accountId, { masterKeyHex: masterKey }),
    ).rejects.toThrow(CredentialFormatError);
  });

  it("7. CredentialFormatError on missing access_token in oauth", async () => {
    const row = sealed(
      JSON.stringify({
        type: "oauth",
        refresh_token: "tok-refresh",
        expires_at: "2026-12-31T00:00:00Z",
      }),
    );
    const db = makeMockDb([row]);
    await expect(
      resolveCredential(db, accountId, { masterKeyHex: masterKey }),
    ).rejects.toThrow(CredentialFormatError);
  });

  it("8. CredentialFormatError on missing refresh_token in oauth", async () => {
    const row = sealed(
      JSON.stringify({
        type: "oauth",
        access_token: "tok-access",
        expires_at: "2026-12-31T00:00:00Z",
      }),
    );
    const db = makeMockDb([row]);
    await expect(
      resolveCredential(db, accountId, { masterKeyHex: masterKey }),
    ).rejects.toThrow(CredentialFormatError);
  });

  it("9. CredentialFormatError on invalid expires_at ISO string", async () => {
    const row = sealed(
      JSON.stringify({
        type: "oauth",
        access_token: "tok-access",
        refresh_token: "tok-refresh",
        expires_at: "not-a-date",
      }),
    );
    const db = makeMockDb([row]);
    await expect(
      resolveCredential(db, accountId, { masterKeyHex: masterKey }),
    ).rejects.toThrow(CredentialFormatError);
  });

  it("dispatches v1 row through decrypt path with version=1", async () => {
    // Encrypt with the current cipher (v2 internals), then claim the row
    // is v1. This won't decrypt because the ciphertext was made with
    // v2 info — we expect decryptCredential to throw, proving
    // resolveCredential actually reads row.cipherVersion and forwards
    // it to the cipher dispatch.
    const row = sealed(
      JSON.stringify({ type: "api_key", api_key: "sk-test" }),
      1,
    );
    const db = makeMockDb([row]);
    await expect(
      resolveCredential(db, accountId, { masterKeyHex: masterKey }),
    ).rejects.toThrow();
  });
});

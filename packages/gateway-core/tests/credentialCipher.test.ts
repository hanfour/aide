import { describe, it, expect } from "vitest";
import {
  encryptCredential,
  decryptCredential,
  CURRENT_CREDENTIAL_CIPHER_VERSION,
} from "../src/crypto/credentialCipher";
import { randomBytes } from "crypto";

const FIXED_MASTER = "a".repeat(64);
const FIXED_ACCOUNT = "00000000-0000-0000-0000-000000000001";
const FIXED_PLAINTEXT = JSON.stringify({ api_key: "sk-ant-test" });

// v1 fixture — pre-recorded ciphertext for (FIXED_MASTER, FIXED_ACCOUNT,
// FIXED_PLAINTEXT) under HKDF info "aide-gateway-credential-v1".
// Regenerate by running the node script in plan Task 3 Step 1.
const V1_FIXTURE = {
  nonce: Buffer.from("070707070707070707070707", "hex"),
  ciphertext: Buffer.from("00b540b7ee14ec68b365edcb8114270beaba1f5bdb5f04ba2a", "hex"),
  authTag: Buffer.from("fdb0bcf9265edf4232c060c8f253c5da", "hex"),
};

describe("credentialCipher", () => {
  it("CURRENT version is 2", () => {
    expect(CURRENT_CREDENTIAL_CIPHER_VERSION).toBe(2);
  });

  it("encrypt + decrypt v2 round-trips", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId: FIXED_ACCOUNT,
      plaintext: FIXED_PLAINTEXT,
    });
    expect(sealed.version).toBe(2);
    const recovered = decryptCredential({
      masterKeyHex: masterKey,
      accountId: FIXED_ACCOUNT,
      sealed,
      version: 2,
    });
    expect(recovered).toBe(FIXED_PLAINTEXT);
  });

  it("decrypts pre-recorded v1 fixture with version: 1", () => {
    const recovered = decryptCredential({
      masterKeyHex: FIXED_MASTER,
      accountId: FIXED_ACCOUNT,
      sealed: V1_FIXTURE,
      version: 1,
    });
    expect(recovered).toBe(FIXED_PLAINTEXT);
  });

  it("v1 ciphertext with version: 2 throws (auth tag mismatch)", () => {
    expect(() =>
      decryptCredential({
        masterKeyHex: FIXED_MASTER,
        accountId: FIXED_ACCOUNT,
        sealed: V1_FIXTURE,
        version: 2,
      }),
    ).toThrow();
  });

  it("v2 ciphertext with version: 1 throws", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId: FIXED_ACCOUNT,
      plaintext: FIXED_PLAINTEXT,
    });
    expect(() =>
      decryptCredential({
        masterKeyHex: masterKey,
        accountId: FIXED_ACCOUNT,
        sealed,
        version: 1,
      }),
    ).toThrow();
  });

  it("fails to decrypt with wrong accountId (HKDF salt mismatch)", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId: "a",
      plaintext: FIXED_PLAINTEXT,
    });
    expect(() =>
      decryptCredential({
        masterKeyHex: masterKey,
        accountId: "b",
        sealed,
        version: 2,
      }),
    ).toThrow();
  });

  it("validates master key format (32 bytes hex)", () => {
    expect(() =>
      encryptCredential({
        masterKeyHex: "too-short",
        accountId: FIXED_ACCOUNT,
        plaintext: FIXED_PLAINTEXT,
      }),
    ).toThrow();
  });

  it("throws when ciphertext is tampered", () => {
    const masterKey = randomBytes(32).toString("hex");
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId: FIXED_ACCOUNT,
      plaintext: FIXED_PLAINTEXT,
    });
    const tampered = {
      ...sealed,
      ciphertext: Buffer.concat([
        sealed.ciphertext.subarray(0, sealed.ciphertext.length - 1),
        Buffer.from([0xff]),
      ]),
    };
    expect(() =>
      decryptCredential({
        masterKeyHex: masterKey,
        accountId: FIXED_ACCOUNT,
        sealed: tampered,
        version: 2,
      }),
    ).toThrow();
  });
});

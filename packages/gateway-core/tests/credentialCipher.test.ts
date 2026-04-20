import { describe, it, expect } from "vitest";
import {
  encryptCredential,
  decryptCredential,
} from "../src/crypto/credentialCipher";
import { randomBytes } from "crypto";

describe("credentialCipher", () => {
  const masterKey = randomBytes(32).toString("hex");
  const accountId = "00000000-0000-0000-0000-000000000001";
  const plaintext = JSON.stringify({ api_key: "sk-ant-test" });

  it("round-trips plaintext through encrypt/decrypt", () => {
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId,
      plaintext,
    });
    const recovered = decryptCredential({
      masterKeyHex: masterKey,
      accountId,
      sealed,
    });
    expect(recovered).toBe(plaintext);
  });

  it("produces different ciphertexts for identical plaintext under different accountIds", () => {
    const a = encryptCredential({
      masterKeyHex: masterKey,
      accountId: "a",
      plaintext,
    });
    const b = encryptCredential({
      masterKeyHex: masterKey,
      accountId: "b",
      plaintext,
    });
    expect(Buffer.compare(a.ciphertext, b.ciphertext)).not.toBe(0);
  });

  it("fails to decrypt with wrong accountId (HKDF salt mismatch)", () => {
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId: "a",
      plaintext,
    });
    expect(() =>
      decryptCredential({ masterKeyHex: masterKey, accountId: "b", sealed }),
    ).toThrow();
  });

  it("validates master key format (32 bytes hex)", () => {
    expect(() =>
      encryptCredential({ masterKeyHex: "too-short", accountId, plaintext }),
    ).toThrow();
  });

  it("throws when ciphertext is tampered (auth tag verifies bytes)", () => {
    const sealed = encryptCredential({
      masterKeyHex: masterKey,
      accountId,
      plaintext,
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
        accountId,
        sealed: tampered,
      }),
    ).toThrow();
  });
});

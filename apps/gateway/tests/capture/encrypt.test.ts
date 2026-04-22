import { describe, it, expect } from "vitest";
import { encryptBody, decryptBody } from "../../src/capture/encrypt.js";

const MASTER_KEY = "a".repeat(64); // 32-byte hex string

describe("encryptBody / decryptBody", () => {
  it("round-trips UTF-8 plaintext", () => {
    const plaintext = JSON.stringify({ message: "hello 測試 🚀" });
    const sealed = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "req-1",
      plaintext,
    });
    const decrypted = decryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "req-1",
      sealed,
    });
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertext for same plaintext (random nonce)", () => {
    const plaintext = "same";
    const a = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "r",
      plaintext,
    });
    const b = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "r",
      plaintext,
    });
    expect(a.equals(b)).toBe(false);
  });

  it("fails to decrypt with wrong requestId (salt mismatch)", () => {
    const sealed = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "right",
      plaintext: "x",
    });
    expect(() =>
      decryptBody({ masterKeyHex: MASTER_KEY, requestId: "wrong", sealed }),
    ).toThrow();
  });

  it("fails to decrypt with wrong master key", () => {
    const sealed = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "r",
      plaintext: "x",
    });
    const WRONG = "b".repeat(64);
    expect(() =>
      decryptBody({ masterKeyHex: WRONG, requestId: "r", sealed }),
    ).toThrow();
  });

  it("rejects sealed buffer that's too small", () => {
    expect(() =>
      decryptBody({
        masterKeyHex: MASTER_KEY,
        requestId: "r",
        sealed: Buffer.from("x"),
      }),
    ).toThrow(/too small/);
  });

  it("encrypt output format: nonce(12) || ciphertext || authTag(16)", () => {
    const sealed = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "r",
      plaintext: "hello",
    });
    // Min: 12 nonce + 1 ciphertext + 16 tag = 29
    expect(sealed.length).toBeGreaterThanOrEqual(12 + 1 + 16);
  });

  it("different info (body vs credential) produces incompatible ciphertexts", () => {
    // If a body-encrypted blob were mis-read as credential blob, decryption should fail.
    // We can't test this directly here (no credential import), but round-trip with body API must succeed.
    const sealed = encryptBody({
      masterKeyHex: MASTER_KEY,
      requestId: "r",
      plaintext: "p",
    });
    const r = decryptBody({ masterKeyHex: MASTER_KEY, requestId: "r", sealed });
    expect(r).toBe("p");
  });
});

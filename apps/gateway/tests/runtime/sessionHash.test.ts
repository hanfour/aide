import { describe, it, expect } from "vitest";
import { generateSessionHash } from "../../src/runtime/sessionHash.js";

describe("generateSessionHash", () => {
  describe("Claude Code metadata.user_id (highest priority)", () => {
    it("extracts the UUID from `user_<hash>_account__session_<uuid>`", () => {
      const hash = generateSessionHash({
        metadata: {
          user_id:
            "user_abc123_account__session_550e8400-e29b-41d4-a716-446655440000",
        },
        messages: [{ role: "user", content: "hi" }],
      });
      expect(hash).toBe("cc:550e8400-e29b-41d4-a716-446655440000");
    });

    it("lowercases UUID to avoid case-only collisions", () => {
      const hash = generateSessionHash({
        metadata: {
          user_id:
            "user_abc_account__session_550E8400-E29B-41D4-A716-446655440000",
        },
      });
      expect(hash).toBe("cc:550e8400-e29b-41d4-a716-446655440000");
    });

    it("falls through when user_id has no _session_<uuid>", () => {
      const hash = generateSessionHash({
        metadata: { user_id: "user_no_session_marker" },
        messages: [{ role: "user", content: "hi" }],
      });
      expect(hash).toBeDefined();
      expect(hash!.startsWith("msg:")).toBe(true);
    });

    it("ignores non-string user_id", () => {
      const hash = generateSessionHash({
        metadata: { user_id: 12345 as unknown as string },
        messages: [{ role: "user", content: "hi" }],
      });
      expect(hash!.startsWith("msg:")).toBe(true);
    });
  });

  describe("system+messages content hash (mid priority)", () => {
    it("returns cnt:<sha> when both system and messages present", () => {
      const hash = generateSessionHash({
        system: "you are helpful",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(hash).toBeDefined();
      expect(hash!.startsWith("cnt:")).toBe(true);
    });

    it("same system+messages → identical hash (stable)", () => {
      const a = generateSessionHash({
        system: "be terse",
        messages: [{ role: "user", content: "hello" }],
      });
      const b = generateSessionHash({
        system: "be terse",
        messages: [{ role: "user", content: "hello" }],
      });
      expect(a).toBe(b);
    });

    it("different system → different hash", () => {
      const a = generateSessionHash({
        system: "be terse",
        messages: [{ role: "user", content: "hi" }],
      });
      const b = generateSessionHash({
        system: "be verbose",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(a).not.toBe(b);
    });
  });

  describe("messages-only hash (lowest fallback)", () => {
    it("returns msg:<sha> when system missing", () => {
      const hash = generateSessionHash({
        messages: [{ role: "user", content: "hello" }],
      });
      expect(hash!.startsWith("msg:")).toBe(true);
    });

    it("treats empty/whitespace system as missing", () => {
      const hash = generateSessionHash({
        system: "",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(hash!.startsWith("msg:")).toBe(true);
    });
  });

  describe("returns undefined when nothing usable", () => {
    it("undefined for empty request", () => {
      expect(generateSessionHash({})).toBeUndefined();
    });

    it("undefined for empty messages array", () => {
      expect(generateSessionHash({ messages: [] })).toBeUndefined();
    });

    it("undefined when system + messages both empty", () => {
      expect(
        generateSessionHash({ system: "", messages: [] }),
      ).toBeUndefined();
    });
  });
});

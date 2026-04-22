import { describe, it, expect } from "vitest";
import { sanitize } from "../../src/capture/sanitizer.js";

describe("sanitize", () => {
  it("masks top-level password string", () => {
    const r = sanitize({ password: "hunter2", user: "alice" });
    expect(r).toEqual({ password: "***", user: "alice" });
  });

  it("masks multiple secret-keyed fields (case-insensitive)", () => {
    const r = sanitize({
      API_KEY: "sk-123",
      Bearer: "xxxxx",
      Cookie: "session=abc",
      Authorization: "Basic Zm9v",
      Secret: "hush",
    });
    expect(r).toEqual({
      API_KEY: "***",
      Bearer: "***",
      Cookie: "***",
      Authorization: "***",
      Secret: "***",
    });
  });

  it("does not mask non-string values at matched keys", () => {
    const r = sanitize({ token: 42, password: true });
    expect(r).toEqual({ token: 42, password: true });
  });

  it("preserves input structure and non-secret fields", () => {
    const r = sanitize({
      user: "alice",
      meta: { age: 30, interests: ["code", "coffee"] },
    });
    expect(r).toEqual({
      user: "alice",
      meta: { age: 30, interests: ["code", "coffee"] },
    });
  });

  it("recursively masks nested secrets", () => {
    const r = sanitize({
      request: {
        headers: { Authorization: "Bearer abc", "X-Trace": "ok" },
      },
    });
    expect(r).toEqual({
      request: {
        headers: { Authorization: "***", "X-Trace": "ok" },
      },
    });
  });

  it("handles arrays containing objects with secrets", () => {
    const r = sanitize([{ password: "a" }, { password: "b" }, { user: "c" }]);
    expect(r).toEqual([
      { password: "***" },
      { password: "***" },
      { user: "c" },
    ]);
  });

  it("is idempotent", () => {
    const input = { token: "xyz", data: { api_key: "k", safe: 1 } };
    expect(sanitize(sanitize(input))).toEqual(sanitize(input));
  });

  it("passes through primitives unchanged", () => {
    expect(sanitize("plain")).toBe("plain");
    expect(sanitize(42)).toBe(42);
    expect(sanitize(null)).toBe(null);
    expect(sanitize(undefined)).toBe(undefined);
    expect(sanitize(true)).toBe(true);
  });

  it("does not mutate input", () => {
    const input = { password: "original" };
    sanitize(input);
    expect(input.password).toBe("original");
  });
});

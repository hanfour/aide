import { describe, it, expect, vi } from "vitest";
import { withRedis, ServiceDegraded } from "../../src/redis/failureMode.js";

describe("withRedis", () => {
  it("returns op value in strict mode on success", async () => {
    const out = await withRedis({ mode: "strict" }, async () => 42, -1);
    expect(out).toBe(42);
  });

  it("returns op value in lenient mode on success", async () => {
    const out = await withRedis({ mode: "lenient" }, async () => "ok", "fallback");
    expect(out).toBe("ok");
  });

  it("strict mode throws ServiceDegraded with cause", async () => {
    const cause = new Error("redis down");
    await expect(
      withRedis({ mode: "strict", label: "test:op" }, async () => { throw cause; }, "fb"),
    ).rejects.toMatchObject({
      name: "ServiceDegraded",
      cause,
    });
  });

  it("ServiceDegraded is instanceof Error", () => {
    const e = new ServiceDegraded("x");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ServiceDegraded");
  });

  it("lenient mode returns static fallback on failure", async () => {
    const out = await withRedis(
      { mode: "lenient" },
      async () => { throw new Error("boom"); },
      "default-value",
    );
    expect(out).toBe("default-value");
  });

  it("lenient mode returns lazy fallback on failure", async () => {
    const out = await withRedis(
      { mode: "lenient" },
      async () => { throw new Error("boom"); },
      async () => 99,
    );
    expect(out).toBe(99);
  });

  it("lenient mode logs warn with label + err", async () => {
    const warn = vi.fn();
    await withRedis(
      { mode: "lenient", logger: { warn }, label: "sticky:get" },
      async () => { throw new Error("oops"); },
      null,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), label: "sticky:get" }),
      expect.any(String),
    );
  });

  it("lenient mode without logger silently swallows", async () => {
    await expect(
      withRedis({ mode: "lenient" }, async () => { throw new Error(); }, "ok"),
    ).resolves.toBe("ok");
  });

  it("re-throws non-Error throwables with String() coercion", async () => {
    await expect(
      withRedis({ mode: "strict", label: "test:string-throw" }, async () => { throw "boom"; }, "fb"),
    ).rejects.toMatchObject({
      name: "ServiceDegraded",
      cause: expect.objectContaining({ message: "boom" }),
    });
  });
});

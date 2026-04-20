import { describe, it, expect, vi } from "vitest";
import { SmartBuffer } from "../../src/runtime/smartBuffer.js";

function makeNow(initial: number) {
  let cur = initial;
  return {
    now: () => cur,
    advance: (ms: number) => {
      cur += ms;
    },
  };
}

describe("SmartBuffer", () => {
  it("1. initial state is BUFFERING and isFailoverEligible=true", () => {
    const buf = new SmartBuffer({
      windowMs: 500,
      windowBytes: 2048,
      onCommit: vi.fn(),
      onPassthrough: vi.fn(),
    });
    expect(buf.state).toBe("BUFFERING");
    expect(buf.isFailoverEligible()).toBe(true);
    expect(buf.bufferedAt).toBeNull();
  });

  it("2. first chunk under both thresholds stays BUFFERING; onCommit not called", async () => {
    const onCommit = vi.fn();
    const buf = new SmartBuffer({
      windowMs: 10_000,
      windowBytes: 2048,
      onCommit,
      onPassthrough: vi.fn(),
    });
    await buf.push(Buffer.from("hello"));
    expect(buf.state).toBe("BUFFERING");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("3. bytes threshold trips commit on the chunk that crosses it; onCommit receives all buffered chunks in order", async () => {
    const onCommit = vi.fn();
    const onPassthrough = vi.fn();
    const buf = new SmartBuffer({
      windowMs: 10_000,
      windowBytes: 10,
      onCommit,
      onPassthrough,
    });
    await buf.push(Buffer.from("1234")); // 4 bytes — under
    await buf.push(Buffer.from("5678")); // 8 bytes — under
    await buf.push(Buffer.from("9abc")); // 12 bytes — crosses
    expect(buf.state).toBe("COMMITTED");
    expect(onCommit).toHaveBeenCalledTimes(1);
    const flushed = onCommit.mock.calls[0]![0] as Buffer[];
    expect(Buffer.concat(flushed).toString()).toBe("123456789abc");
    expect(onPassthrough).not.toHaveBeenCalled();
  });

  it("4. time threshold trips commit on next chunk arriving after windowMs elapsed", async () => {
    const clock = makeNow(1000);
    const onCommit = vi.fn();
    const buf = new SmartBuffer({
      windowMs: 500,
      windowBytes: 999_999,
      onCommit,
      onPassthrough: vi.fn(),
      now: clock.now,
    });
    await buf.push(Buffer.from("a"));
    expect(buf.state).toBe("BUFFERING");
    clock.advance(600);
    await buf.push(Buffer.from("b"));
    expect(buf.state).toBe("COMMITTED");
    expect(onCommit.mock.calls[0]![0]).toEqual([
      Buffer.from("a"),
      Buffer.from("b"),
    ]);
  });

  it("5. both thresholds at zero → first chunk commits immediately", async () => {
    const onCommit = vi.fn();
    const buf = new SmartBuffer({
      windowMs: 0,
      windowBytes: 0,
      onCommit,
      onPassthrough: vi.fn(),
    });
    const state = await buf.push(Buffer.from("x"));
    expect(state).toBe("COMMITTED");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect((onCommit.mock.calls[0]![0] as Buffer[])[0]).toEqual(
      Buffer.from("x"),
    );
  });

  it("6. post-commit chunk goes through onPassthrough, NOT onCommit", async () => {
    const onCommit = vi.fn();
    const onPassthrough = vi.fn();
    const buf = new SmartBuffer({
      windowMs: 0,
      windowBytes: 0,
      onCommit,
      onPassthrough,
    });
    await buf.push(Buffer.from("first")); // triggers commit
    expect(buf.state).toBe("COMMITTED");
    onCommit.mockClear();
    await buf.push(Buffer.from("second"));
    expect(onPassthrough).toHaveBeenCalledTimes(1);
    expect(onPassthrough.mock.calls[0]![0]).toEqual(Buffer.from("second"));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("7. manual commit() flushes buffered chunks", async () => {
    const onCommit = vi.fn();
    const buf = new SmartBuffer({
      windowMs: 10_000,
      windowBytes: 99_999,
      onCommit,
      onPassthrough: vi.fn(),
    });
    await buf.push(Buffer.from("chunk1"));
    await buf.push(Buffer.from("chunk2"));
    expect(buf.state).toBe("BUFFERING");
    await buf.commit();
    expect(buf.state).toBe("COMMITTED");
    expect(onCommit).toHaveBeenCalledTimes(1);
    const flushed = onCommit.mock.calls[0]![0] as Buffer[];
    expect(Buffer.concat(flushed).toString()).toBe("chunk1chunk2");
  });

  it("8. manual commit() on already-COMMITTED is a no-op", async () => {
    const onCommit = vi.fn();
    const buf = new SmartBuffer({
      windowMs: 0,
      windowBytes: 0,
      onCommit,
      onPassthrough: vi.fn(),
    });
    await buf.push(Buffer.from("x")); // triggers commit
    expect(onCommit).toHaveBeenCalledTimes(1);
    await buf.commit();
    expect(onCommit).toHaveBeenCalledTimes(1); // still once
    expect(buf.state).toBe("COMMITTED");
  });

  it("9. discard() before commit drops accumulated chunks; subsequent commit yields empty onCommit (not called)", async () => {
    const onCommit = vi.fn();
    const buf = new SmartBuffer({
      windowMs: 10_000,
      windowBytes: 99_999,
      onCommit,
      onPassthrough: vi.fn(),
    });
    await buf.push(Buffer.from("a"));
    await buf.push(Buffer.from("b"));
    buf.discard();
    await buf.commit();
    // onCommit only fires if chunks.length > 0; after discard, no chunks
    expect(onCommit).not.toHaveBeenCalled();
    expect(buf.state).toBe("COMMITTED");
  });

  it("10. discard() after commit is a no-op (state stays COMMITTED)", async () => {
    const onCommit = vi.fn();
    const onPassthrough = vi.fn();
    const buf = new SmartBuffer({
      windowMs: 0,
      windowBytes: 0,
      onCommit,
      onPassthrough,
    });
    await buf.push(Buffer.from("x")); // triggers commit
    expect(buf.state).toBe("COMMITTED");
    buf.discard(); // should be no-op
    expect(buf.state).toBe("COMMITTED");
    // post-commit push still goes through passthrough (not wiped)
    await buf.push(Buffer.from("y"));
    expect(onPassthrough).toHaveBeenCalledTimes(1);
  });

  it("11. isFailoverEligible flips false after commit", async () => {
    const buf = new SmartBuffer({
      windowMs: 0,
      windowBytes: 0,
      onCommit: vi.fn(),
      onPassthrough: vi.fn(),
    });
    expect(buf.isFailoverEligible()).toBe(true);
    await buf.push(Buffer.from("x"));
    expect(buf.isFailoverEligible()).toBe(false);
  });

  it("12. bufferedAt is null while BUFFERING, returns elapsed ms after commit", async () => {
    const clock = makeNow(0);
    const buf = new SmartBuffer({
      windowMs: 10_000,
      windowBytes: 99_999,
      onCommit: vi.fn(),
      onPassthrough: vi.fn(),
      now: clock.now,
    });
    expect(buf.bufferedAt).toBeNull();
    clock.advance(250);
    expect(buf.bufferedAt).toBeNull();
    await buf.commit();
    clock.advance(50);
    // bufferedAt = now() - startedAt = (0+250+50) - 0 = 300
    expect(buf.bufferedAt).toBe(300);
  });

  it("13. async onCommit is awaited (push resolves after onCommit resolves)", async () => {
    const order: string[] = [];
    const onCommit = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            order.push("onCommit-resolved");
            resolve();
          }, 10);
        }),
    );
    const buf = new SmartBuffer({
      windowMs: 0,
      windowBytes: 0,
      onCommit,
      onPassthrough: vi.fn(),
    });
    await buf.push(Buffer.from("x"));
    order.push("push-returned");
    expect(order).toEqual(["onCommit-resolved", "push-returned"]);
  });

  it("14. async onPassthrough is awaited", async () => {
    const order: string[] = [];
    const onPassthrough = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            order.push("onPassthrough-resolved");
            resolve();
          }, 10);
        }),
    );
    const buf = new SmartBuffer({
      windowMs: 0,
      windowBytes: 0,
      onCommit: vi.fn(),
      onPassthrough,
    });
    await buf.push(Buffer.from("first")); // commits
    await buf.push(Buffer.from("second")); // passthrough
    order.push("push-returned");
    expect(order).toEqual(["onPassthrough-resolved", "push-returned"]);
  });

  it("15. windowBytes=MAX_SAFE_INTEGER + windowMs=10 → time wins, commits on chunk after 10ms elapsed", async () => {
    const clock = makeNow(0);
    const onCommit = vi.fn();
    const buf = new SmartBuffer({
      windowMs: 10,
      windowBytes: Number.MAX_SAFE_INTEGER,
      onCommit,
      onPassthrough: vi.fn(),
      now: clock.now,
    });
    await buf.push(Buffer.from("a"));
    expect(buf.state).toBe("BUFFERING");
    clock.advance(5);
    await buf.push(Buffer.from("b"));
    expect(buf.state).toBe("BUFFERING");
    clock.advance(10); // total elapsed = 15 >= 10
    await buf.push(Buffer.from("c"));
    expect(buf.state).toBe("COMMITTED");
    expect(onCommit).toHaveBeenCalledTimes(1);
    const flushed = onCommit.mock.calls[0]![0] as Buffer[];
    expect(Buffer.concat(flushed).toString()).toBe("abc");
  });
});

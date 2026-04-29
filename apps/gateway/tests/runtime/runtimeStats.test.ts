import { describe, it, expect } from "vitest";
import { AccountRuntimeStats } from "../../src/runtime/runtimeStats.js";

describe("AccountRuntimeStats", () => {
  it("returns neutral stat for unknown account (errorRate=0, ttftMs=NaN)", () => {
    const stats = new AccountRuntimeStats();
    const s = stats.score("unknown");
    expect(s.errorRate).toBe(0);
    expect(Number.isNaN(s.ttftMs)).toBe(true);
    expect(stats.size()).toBe(0);
  });

  it("first observation seeds ttftMs directly (no NaN propagation)", () => {
    const stats = new AccountRuntimeStats({ alpha: 0.2 });
    stats.record("a", true, 250);
    const s = stats.score("a");
    expect(s.ttftMs).toBe(250);
    expect(s.errorRate).toBeCloseTo(0, 6);
  });

  it("error observation drives errorRate up via EWMA", () => {
    const stats = new AccountRuntimeStats({ alpha: 0.2 });
    stats.record("a", true, 100);
    stats.record("a", false, 100);
    const s = stats.score("a");
    // 0.2 * 1 + 0.8 * 0 = 0.2
    expect(s.errorRate).toBeCloseTo(0.2, 6);
  });

  it("repeated successes decay errorRate back toward 0", () => {
    const stats = new AccountRuntimeStats({ alpha: 0.2 });
    stats.record("a", false, 100); // errorRate = 0.2
    stats.record("a", true, 100); // 0.2*0 + 0.8*0.2 = 0.16
    stats.record("a", true, 100); // 0.128
    stats.record("a", true, 100); // 0.1024
    expect(stats.score("a").errorRate).toBeCloseTo(0.1024, 4);
  });

  it("ttft EWMA blends new observations with history", () => {
    const stats = new AccountRuntimeStats({ alpha: 0.2 });
    stats.record("a", true, 100);
    stats.record("a", true, 500);
    // 0.2*500 + 0.8*100 = 180
    expect(stats.score("a").ttftMs).toBeCloseTo(180, 6);
  });

  it("record without firstTokenMs preserves prior ttft", () => {
    const stats = new AccountRuntimeStats({ alpha: 0.2 });
    stats.record("a", true, 200);
    stats.record("a", false); // no ttft sample
    expect(stats.score("a").ttftMs).toBe(200);
    expect(stats.score("a").errorRate).toBeCloseTo(0.2, 6);
  });

  it("weightedScore treats unknown account as fast (uses ttft floor)", () => {
    const stats = new AccountRuntimeStats({ alpha: 0.2, ttftFloorMs: 100 });
    // basePriority=1, ttft=100 floor, errorRate=0 -> 1 * 1 * 1/100 = 0.01
    expect(stats.weightedScore("cold", 1)).toBeCloseTo(0.01, 6);
  });

  it("weightedScore weighs observed-fast over observed-slow", () => {
    const stats = new AccountRuntimeStats({ alpha: 0.2, ttftFloorMs: 100 });
    stats.record("fast", true, 200);
    stats.record("slow", true, 800);
    expect(stats.weightedScore("fast", 1)).toBeGreaterThan(
      stats.weightedScore("slow", 1),
    );
  });

  it("weightedScore drops to ~0 when errorRate approaches 1", () => {
    const stats = new AccountRuntimeStats({ alpha: 1, ttftFloorMs: 100 });
    // alpha=1 means full overwrite — error_rate = 1
    stats.record("dead", false, 200);
    expect(stats.weightedScore("dead", 1)).toBe(0);
  });

  it("snapshot returns immutable copies (mutations don't bleed back)", () => {
    const stats = new AccountRuntimeStats();
    stats.record("a", true, 200);
    const snap = stats.snapshot();
    snap[0]!.stat.errorRate = 999;
    expect(stats.score("a").errorRate).toBeCloseTo(0, 6);
  });

  it("forget removes the account from tracking", () => {
    const stats = new AccountRuntimeStats();
    stats.record("a", true, 100);
    expect(stats.size()).toBe(1);
    stats.forget("a");
    expect(stats.size()).toBe(0);
    const reset = stats.score("a");
    expect(reset.errorRate).toBe(0);
    expect(Number.isNaN(reset.ttftMs)).toBe(true);
  });
});

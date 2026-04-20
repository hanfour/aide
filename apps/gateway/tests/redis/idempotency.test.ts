import { describe, it, expect, beforeEach, afterEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import {
  getCached, setCached, setInFlight, isInFlight,
  type IdempotencyEntry,
} from "../../src/redis/idempotency.js";

describe("idempotency", () => {
  let redis: Redis;

  beforeEach(() => {
    redis = new RedisMock({ keyPrefix: "aide:gw:" }) as unknown as Redis;
  });

  afterEach(async () => {
    await redis.quit().catch(() => {});
  });

  it("getCached returns null when key absent", async () => {
    expect(await getCached(redis, "missing")).toBeNull();
  });

  it("round-trips a CachedResponse", async () => {
    await setCached(redis, "req-1", {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    }, 300);
    const got = await getCached(redis, "req-1");
    expect(got).toMatchObject({ status: 200, body: '{"ok":true}' });
  });

  it("setInFlight + getCached returns marker; isInFlight narrows", async () => {
    await setInFlight(redis, "req-2", 300);
    const got = await getCached(redis, "req-2");
    expect(got).not.toBeNull();
    expect(isInFlight(got as IdempotencyEntry)).toBe(true);
    if (got && isInFlight(got)) {
      expect(typeof got.startedAt).toBe("number");
    }
  });

  it("malformed JSON returns null", async () => {
    await redis.set("idem:bad", "this is not json", "EX", 60);
    expect(await getCached(redis, "bad")).toBeNull();
  });

  it("setCached respects ttlSec", async () => {
    await setCached(redis, "req-3", { status: 200, headers: {}, body: "" }, 120);
    const ttl = await redis.ttl("idem:req-3");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it("setInFlight respects ttlSec", async () => {
    await setInFlight(redis, "req-4", 60);
    const ttl = await redis.ttl("idem:req-4");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("setCached overwrites prior setInFlight", async () => {
    await setInFlight(redis, "req-5", 300);
    await setCached(redis, "req-5", { status: 201, headers: {}, body: "ok" }, 300);
    const got = await getCached(redis, "req-5");
    expect(got).not.toBeNull();
    expect(isInFlight(got!)).toBe(false);
    expect(got).toMatchObject({ status: 201 });
  });
});

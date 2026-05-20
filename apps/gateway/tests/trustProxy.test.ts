import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { parseTrustedProxies } from "../src/server.js";

// Trust-proxy hardening: req.ip must come from X-Forwarded-For only when
// the socket peer is in the configured CIDR list, otherwise the spoofed
// header is ignored and req.ip falls back to the socket peer.
//
// Tests boot a tiny Fastify with the same trustProxy parse helper that
// buildServer uses, avoiding the full gateway + redis + db wiring.

describe("parseTrustedProxies", () => {
  it("returns false for empty input (no proxy trusted)", () => {
    expect(parseTrustedProxies("")).toBe(false);
    expect(parseTrustedProxies("   ")).toBe(false);
    expect(parseTrustedProxies(",,,")).toBe(false);
  });

  it("returns a trimmed array for a single CIDR", () => {
    expect(parseTrustedProxies("10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
    expect(parseTrustedProxies("  10.0.0.0/8  ")).toEqual(["10.0.0.0/8"]);
  });

  it("splits comma-separated CIDRs and trims whitespace", () => {
    expect(parseTrustedProxies("127.0.0.1,10.0.0.0/8, 192.168.0.0/16")).toEqual([
      "127.0.0.1",
      "10.0.0.0/8",
      "192.168.0.0/16",
    ]);
  });
});

describe("Fastify trustProxy wiring", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    for (const app of apps) {
      await app.close();
    }
    apps.length = 0;
  });

  function makeProbe(trustProxy: false | string[]): FastifyInstance {
    const app = Fastify({ logger: false, trustProxy });
    app.get("/probe", async (req) => ({ ip: req.ip }));
    apps.push(app);
    return app;
  }

  it("ignores X-Forwarded-For when trustProxy is false (no proxy configured)", async () => {
    const app = makeProbe(parseTrustedProxies(""));
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    // Should NOT be 203.0.113.1; socket peer wins.
    expect(res.json().ip).not.toBe("203.0.113.1");
  });

  it("honours X-Forwarded-For when the socket peer matches the trusted CIDR", async () => {
    // app.inject's default remoteAddress is 127.0.0.1, which is in 127.0.0.0/8.
    const app = makeProbe(parseTrustedProxies("127.0.0.0/8"));
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    expect(res.json().ip).toBe("203.0.113.1");
  });

  it("ignores X-Forwarded-For when the socket peer is outside the trusted CIDR", async () => {
    const app = makeProbe(parseTrustedProxies("10.0.0.0/8"));
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { "x-forwarded-for": "203.0.113.1" },
      remoteAddress: "192.0.2.5", // outside 10.0.0.0/8
    });
    expect(res.json().ip).toBe("192.0.2.5");
  });

  it("honours X-Forwarded-For from the matching CIDR among multiple", async () => {
    const app = makeProbe(
      parseTrustedProxies("10.0.0.0/8, 192.0.2.0/24"),
    );
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { "x-forwarded-for": "203.0.113.7" },
      remoteAddress: "192.0.2.5",
    });
    expect(res.json().ip).toBe("203.0.113.7");
  });
});

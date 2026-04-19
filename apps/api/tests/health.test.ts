import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { healthRoutes } from "../src/rest/health.js";

type MockExecute = (..._args: unknown[]) => Promise<unknown>;

function appWith(dbExecute: MockExecute | undefined) {
  const app = Fastify();
  // Mirror the decoration that authPlugin would add in production. The cast
  // to `never` is deliberate — we only exercise the .execute method, not the
  // full NodePgDatabase surface the module augmentation promises.
  const mock = dbExecute
    ? ({ execute: dbExecute } as unknown as never)
    : (undefined as unknown as never);
  app.decorate("db", mock);
  return app;
}

describe("health routes", () => {
  it("GET /health reports db: up when the probe succeeds", async () => {
    const app = appWith(async () => ({ rows: [{ ok: 1 }] }));
    await app.register(healthRoutes);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", db: "up" });
    await app.close();
  });

  it("GET /health reports db: down when the probe throws", async () => {
    const app = appWith(async () => {
      throw new Error("connection refused");
    });
    await app.register(healthRoutes);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "degraded", db: "down" });
    await app.close();
  });

  it("GET /health/ready returns 200 when migrations have been applied", async () => {
    let call = 0;
    const app = appWith(async () => {
      call += 1;
      // First call: select 1 (liveness). Second: migrations count.
      return call === 1 ? { rows: [] } : { rows: [{ count: "3" }] };
    });
    await app.register(healthRoutes);
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ready", migrations: 3 });
    await app.close();
  });

  it("GET /health/ready returns 503 when migrations have not run", async () => {
    let call = 0;
    const app = appWith(async () => {
      call += 1;
      return call === 1 ? { rows: [] } : { rows: [{ count: "0" }] };
    });
    await app.register(healthRoutes);
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "not_ready",
      reason: "migrations_pending",
    });
    await app.close();
  });

  it("GET /health/ready returns 503 when the db is unreachable", async () => {
    const app = appWith(async () => {
      throw new Error("ECONNREFUSED");
    });
    await app.register(healthRoutes);
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready" });
    await app.close();
  });
});

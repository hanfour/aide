import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { healthRoutes } from "../src/rest/health.js";

describe("health routes", () => {
  it("GET /health returns ok", async () => {
    const app = Fastify();
    await app.register(healthRoutes);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    await app.close();
  });

  it("GET /health/ready returns 200", async () => {
    const app = Fastify();
    await app.register(healthRoutes);
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

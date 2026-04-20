import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";

describe("gateway server", () => {
  it("responds 200 on /health", async () => {
    const app = await buildServer({ enabled: true });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
  it('returns {status:"disabled"} when ENABLE_GATEWAY=false', async () => {
    const app = await buildServer({ enabled: false });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({ status: "disabled" });
    await app.close();
  });
});

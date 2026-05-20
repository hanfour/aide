import { describe, it, expect } from "vitest";
import { buildTrpcErrorLogPayload } from "../../src/trpc/onErrorLog.js";

describe("buildTrpcErrorLogPayload", () => {
  const error = { code: "BAD_REQUEST", message: "boom" };
  const path = "invites.accept";
  const input = { token: "abc.def.ghi.SECRET" };

  it("omits input when NODE_ENV is production", () => {
    const payload = buildTrpcErrorLogPayload(
      { error, path, input },
      { NODE_ENV: "production" },
    );
    expect(payload).toMatchObject({
      path,
      code: error.code,
      message: error.message,
    });
    expect(payload).not.toHaveProperty("input");
  });

  it("keeps input verbatim in development (pino redact paths handle scrubbing)", () => {
    const payload = buildTrpcErrorLogPayload(
      { error, path, input },
      { NODE_ENV: "development" },
    );
    expect(payload.input).toEqual(input);
  });

  it("keeps input verbatim in test (so vitest assertions can see it)", () => {
    const payload = buildTrpcErrorLogPayload(
      { error, path, input },
      { NODE_ENV: "test" },
    );
    expect(payload.input).toEqual(input);
  });

  it("surfaces error.cause.message when cause is an Error", () => {
    const cause = new Error("downstream timeout");
    const payload = buildTrpcErrorLogPayload(
      { error: { ...error, cause }, path, input: {} },
      { NODE_ENV: "production" },
    );
    expect(payload.cause).toBe("downstream timeout");
  });

  it("treats undefined NODE_ENV as non-production (keeps input)", () => {
    const payload = buildTrpcErrorLogPayload(
      { error, path, input },
      {},
    );
    expect(payload.input).toEqual(input);
  });
});

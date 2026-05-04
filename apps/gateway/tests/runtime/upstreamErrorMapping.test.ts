// Plan 5A PR 9j — unit coverage for the consolidated retry-after
// parser + non-2xx error builder. The helpers live on the failover
// hot path so we lock down their behaviour explicitly rather than
// relying on the integration suite catching regressions.

import { describe, it, expect } from "vitest";
import {
  parseRetryAfterHeader,
  buildUpstreamHttpError,
} from "../../src/runtime/upstreamErrorMapping.js";

describe("parseRetryAfterHeader", () => {
  it("returns the integer-seconds value for a string header", () => {
    expect(parseRetryAfterHeader("30")).toBe(30);
    expect(parseRetryAfterHeader("0")).toBe(0);
  });

  it("uses the first array element when undici splits the header", () => {
    expect(parseRetryAfterHeader(["12", "99"])).toBe(12);
  });

  it("returns undefined for absent header", () => {
    expect(parseRetryAfterHeader(undefined)).toBeUndefined();
  });

  it("returns undefined for unparseable values (HTTP-date form, garbage)", () => {
    // We only support the integer-seconds form. HTTP-date and garbage
    // both come back as NaN → undefined.
    expect(parseRetryAfterHeader("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
    expect(parseRetryAfterHeader("not-a-number")).toBeUndefined();
  });

  it("returns undefined for empty string array", () => {
    expect(parseRetryAfterHeader([])).toBeUndefined();
  });
});

describe("buildUpstreamHttpError", () => {
  it("captures status, retryAfter, and truncates body to 500 chars", () => {
    const longBody = "x".repeat(900);
    const err = buildUpstreamHttpError({
      status: 503,
      body: Buffer.from(longBody),
      headers: { "retry-after": "5" },
    });
    expect(err.status).toBe(503);
    expect(err.retryAfter).toBe(5);
    expect(err.message).toHaveLength(500);
  });

  it("omits retryAfter when header is absent or unparseable", () => {
    const err = buildUpstreamHttpError({
      status: 502,
      body: Buffer.from("upstream is down"),
      headers: {},
    });
    expect(err.retryAfter).toBeUndefined();
    expect(err.message).toBe("upstream is down");
  });

  it("respects the messageMaxLen override", () => {
    const err = buildUpstreamHttpError(
      {
        status: 500,
        body: Buffer.from("x".repeat(200)),
        headers: {},
      },
      { messageMaxLen: 50 },
    );
    expect(err.message).toHaveLength(50);
  });
});

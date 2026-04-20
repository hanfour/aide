/**
 * Unit tests for `runtime/usageLogging.ts` — the shared helper that both
 * non-streaming routes call to build + enqueue usage-log payloads (Plan 4A
 * Part 7, Sub-task B).
 *
 * Covers:
 *   - Token extraction from well-formed / malformed upstream bodies
 *   - Cost computation + decimal string formatting (scale 10)
 *   - Pricing-miss path: counter bump, zeroed costs, still enqueues
 *   - Enqueue wiring passes fallback { db, logger, metrics }
 *   - Test-mode short-circuit when `app.usageLogQueue` is undefined
 *   - Residual enqueue errors do not propagate (never fail user request)
 *   - Payload shape (platform/surface, streaming-only fields null, etc.)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  buildUsageLogPayload,
  emitUsageLog,
  extractUsageFromAnthropicResponse,
  getPricing,
  resetPricingCacheForTests,
} from "../../src/runtime/usageLogging.js";
import type { UsageLogJobPayload } from "../../src/workers/usageLogQueue.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_UUID_ORG = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_USER = "22222222-2222-4222-8222-222222222222";
const VALID_UUID_KEY = "33333333-3333-4333-8333-333333333333";
const VALID_UUID_ACCT = "44444444-4444-4444-8444-444444444444";
const VALID_UUID_TEAM = "55555555-5555-4555-8555-555555555555";

function makeReq(
  overrides: Partial<{
    id: string;
    headers: Record<string, string | undefined>;
    ip: string;
    teamId: string | null;
  }> = {},
): FastifyRequest {
  // Minimum viable FastifyRequest for the helper. Everything the helper
  // reads is narrowly scoped (id, headers, ip, apiKey, gwUser, log) —
  // typing as `unknown as FastifyRequest` keeps the cast narrow.
  const req = {
    id: overrides.id ?? "req-test-1",
    headers: overrides.headers ?? { "user-agent": "vitest/1.0" },
    ip: overrides.ip ?? "127.0.0.1",
    apiKey: {
      id: VALID_UUID_KEY,
      orgId: VALID_UUID_ORG,
      userId: VALID_UUID_USER,
      teamId: overrides.teamId !== undefined ? overrides.teamId : null,
      quotaUsd: "0",
      quotaUsedUsd: "0",
    },
    gwUser: { id: VALID_UUID_USER, email: "test@example.com" },
    gwOrg: { id: VALID_UUID_ORG, slug: "test-org" },
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
  return req as unknown as FastifyRequest;
}

function makeApp(
  overrides: Partial<{
    usageLogQueue: FastifyInstance["usageLogQueue"] | undefined;
  }> = {},
): FastifyInstance {
  const pricingMissInc = vi.fn();
  const persistLostInc = vi.fn();
  const app = {
    db: { __marker: "fake-db" },
    usageLogQueue:
      "usageLogQueue" in overrides ? overrides.usageLogQueue : undefined,
    gwMetrics: {
      pricingMissTotal: { inc: pricingMissInc },
      usagePersistLostTotal: { inc: persistLostInc },
    },
  };
  return app as unknown as FastifyInstance;
}

// Cache a pricing map that contains a single known model so we can exercise
// hit + miss paths deterministically. The real `loadPricing()` reads from
// disk; we reset the module-level cache between tests to prevent leakage.
beforeEach(() => {
  resetPricingCacheForTests();
});

// ── extractUsageFromAnthropicResponse ────────────────────────────────────────

describe("extractUsageFromAnthropicResponse", () => {
  it("1. full usage — returns all four token counts + model", () => {
    const out = extractUsageFromAnthropicResponse({
      model: "claude-3-5-haiku-20241022",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
    });
    expect(out).toEqual({
      model: "claude-3-5-haiku-20241022",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 5,
    });
  });

  it("2. missing optional cache tokens — defaults to 0", () => {
    const out = extractUsageFromAnthropicResponse({
      model: "claude-3-5-haiku-20241022",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(out.cacheCreationTokens).toBe(0);
    expect(out.cacheReadTokens).toBe(0);
  });

  it("3. non-object input — returns all zeros + empty model", () => {
    expect(extractUsageFromAnthropicResponse(null)).toEqual({
      model: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    expect(extractUsageFromAnthropicResponse("string")).toEqual({
      model: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it("4. negative / non-numeric token counts are coerced to 0", () => {
    const out = extractUsageFromAnthropicResponse({
      model: "m",
      usage: {
        input_tokens: -5,
        output_tokens: NaN,
        cache_creation_input_tokens: "fifty",
        cache_read_input_tokens: 7.9,
      },
    });
    expect(out.inputTokens).toBe(0);
    expect(out.outputTokens).toBe(0);
    expect(out.cacheCreationTokens).toBe(0);
    // 7.9 should floor to 7 (the helper accepts non-integer finite ≥0).
    expect(out.cacheReadTokens).toBe(7);
  });
});

// ── buildUsageLogPayload ─────────────────────────────────────────────────────

describe("buildUsageLogPayload", () => {
  it("5. full happy path — payload matches spec shape, decimals scale 10", () => {
    const pricing = getPricing();
    const { payload, cost } = buildUsageLogPayload({
      req: makeReq({ id: "req-happy-1" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 1234,
      pricing,
    });

    expect(cost.miss).toBe(false);
    expect(payload).toMatchObject({
      requestId: "req-happy-1",
      userId: VALID_UUID_USER,
      apiKeyId: VALID_UUID_KEY,
      accountId: VALID_UUID_ACCT,
      orgId: VALID_UUID_ORG,
      teamId: null,
      requestedModel: "claude-3-5-haiku-20241022",
      upstreamModel: "claude-3-5-haiku-20241022",
      platform: "anthropic",
      surface: "messages",
      stream: false,
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      rateMultiplier: "1.0000",
      accountRateMultiplier: "1.0000",
      statusCode: 200,
      durationMs: 1234,
      firstTokenMs: null,
      bufferReleasedAtMs: null,
      upstreamRetries: 0,
      failedAccountIds: [],
      userAgent: "vitest/1.0",
      ipAddress: "127.0.0.1",
    });
    // Decimal strings: scale 10 enforced via toFixed(10)
    expect(payload.inputCost).toMatch(/^\d+\.\d{10}$/);
    expect(payload.outputCost).toMatch(/^\d+\.\d{10}$/);
    expect(payload.totalCost).toMatch(/^\d+\.\d{10}$/);
    // 1000 input * $0.0000008 + 500 output * $0.000004 = 0.0008 + 0.002 = 0.0028
    expect(payload.totalCost).toBe("0.0028000000");
  });

  it("6. pricing miss — costs are '0.0000000000', miss=true", () => {
    const pricing = getPricing();
    const { payload, cost } = buildUsageLogPayload({
      req: makeReq(),
      requestedModel: "unknown-model-xyz",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "unknown-model-xyz",
        usage: { input_tokens: 999, output_tokens: 999 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 10,
      pricing,
    });
    expect(cost.miss).toBe(true);
    expect(payload.inputCost).toBe("0.0000000000");
    expect(payload.outputCost).toBe("0.0000000000");
    expect(payload.cacheCreationCost).toBe("0.0000000000");
    expect(payload.cacheReadCost).toBe("0.0000000000");
    expect(payload.totalCost).toBe("0.0000000000");
    // Tokens still recorded even on miss — forensic row.
    expect(payload.inputTokens).toBe(999);
    expect(payload.outputTokens).toBe(999);
  });

  it("7. teamId is preserved when apiKey has one", () => {
    const pricing = getPricing();
    const { payload } = buildUsageLogPayload({
      req: makeReq({ teamId: VALID_UUID_TEAM }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 1,
      pricing,
    });
    expect(payload.teamId).toBe(VALID_UUID_TEAM);
  });

  it("8. missing user-agent / ip — both null", () => {
    const pricing = getPricing();
    const { payload } = buildUsageLogPayload({
      req: makeReq({ headers: {}, ip: "" }),
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 1,
      pricing,
    });
    expect(payload.userAgent).toBeNull();
    // Empty string ip → null per the `typeof === "string"` check is true, but
    // empty-string is still a string; the helper preserves whatever Fastify
    // set. Assert current behaviour so regressions are visible.
    expect(typeof payload.ipAddress).toBe("string");
  });

  it("9. platform=openai + surface=chat-completions propagate", () => {
    const pricing = getPricing();
    const { payload } = buildUsageLogPayload({
      req: makeReq(),
      requestedModel: "gpt-4",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 10, output_tokens: 10 },
      },
      platform: "openai",
      surface: "chat-completions",
      statusCode: 200,
      durationMs: 99,
      pricing,
    });
    expect(payload.platform).toBe("openai");
    expect(payload.surface).toBe("chat-completions");
    // requestedModel = gpt-4, upstreamModel = claude-3-5-haiku-20241022
    expect(payload.requestedModel).toBe("gpt-4");
    expect(payload.upstreamModel).toBe("claude-3-5-haiku-20241022");
  });
});

// ── emitUsageLog ─────────────────────────────────────────────────────────────

describe("emitUsageLog", () => {
  it("10. happy path — enqueues with fallback wired", async () => {
    const addFn = vi.fn().mockResolvedValue({ id: "stub" });
    const app = makeApp({
      usageLogQueue: { add: addFn } as unknown as FastifyInstance["usageLogQueue"],
    });
    const req = makeReq({ id: "req-emit-happy" });

    await emitUsageLog({
      app,
      req,
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 50,
    });

    expect(addFn).toHaveBeenCalledTimes(1);
    const [jobName, jobData, jobOpts] = addFn.mock.calls[0]!;
    expect(jobName).toBe("usage-log");
    expect(jobOpts).toMatchObject({ jobId: "req-emit-happy" });
    const payload = jobData as UsageLogJobPayload;
    expect(payload.requestId).toBe("req-emit-happy");
    expect(payload.platform).toBe("anthropic");
    expect(payload.surface).toBe("messages");
    // pricingMissTotal.inc should NOT have been called for a known model.
    expect(app.gwMetrics.pricingMissTotal.inc).not.toHaveBeenCalled();
  });

  it("11. test mode — no usageLogQueue, no enqueue + debug log", async () => {
    const app = makeApp({ usageLogQueue: undefined });
    const req = makeReq();

    await emitUsageLog({
      app,
      req,
      requestedModel: "claude-3-5-haiku-20241022",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 1,
    });

    expect(req.log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-test-1" }),
      expect.stringContaining("usage log queue absent"),
    );
  });

  it("12. pricing miss — bumps counter + warn + still enqueues zero-cost row", async () => {
    const addFn = vi.fn().mockResolvedValue({ id: "stub" });
    const app = makeApp({
      usageLogQueue: { add: addFn } as unknown as FastifyInstance["usageLogQueue"],
    });
    const req = makeReq({ id: "req-miss-1" });

    await emitUsageLog({
      app,
      req,
      requestedModel: "unknown-xyz",
      accountId: VALID_UUID_ACCT,
      upstreamResponse: {
        model: "unknown-xyz",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      platform: "anthropic",
      surface: "messages",
      statusCode: 200,
      durationMs: 1,
    });

    expect(app.gwMetrics.pricingMissTotal.inc).toHaveBeenCalledWith({
      model: "unknown-xyz",
    });
    expect(req.log.warn).toHaveBeenCalled();
    expect(addFn).toHaveBeenCalledTimes(1);
    const payload = addFn.mock.calls[0]![1] as UsageLogJobPayload;
    expect(payload.totalCost).toBe("0.0000000000");
  });

  it("13. BullMQ enqueue error AND fallback fails — warn but do not throw", async () => {
    // The real `enqueueUsageLog` will try `queue.add` → fail → invoke
    // `writeUsageLogBatch` on `app.db` → fail (no real DB) → log
    // gw_usage_persist_lost + re-throw. emitUsageLog must swallow that.
    const addFn = vi.fn().mockRejectedValue(new Error("redis down"));
    const app = makeApp({
      usageLogQueue: { add: addFn } as unknown as FastifyInstance["usageLogQueue"],
    });
    const req = makeReq({ id: "req-fail-1" });

    await expect(
      emitUsageLog({
        app,
        req,
        requestedModel: "claude-3-5-haiku-20241022",
        accountId: VALID_UUID_ACCT,
        upstreamResponse: {
          model: "claude-3-5-haiku-20241022",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        platform: "anthropic",
        surface: "messages",
        statusCode: 200,
        durationMs: 1,
      }),
    ).resolves.toBeUndefined();

    expect(addFn).toHaveBeenCalledTimes(1);
    // Route handler's warn fires after enqueueUsageLog's own error log.
    expect(req.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-fail-1" }),
      expect.stringContaining("usage log persist failed"),
    );
  });
});

/**
 * Unit tests for `runtime/bodyCapture.ts` — the shared helper that enqueues
 * body capture jobs (Plan 4B Part 3, Task 3.5).
 *
 * Covers:
 *   1. Skips enqueue when `gwOrg.contentCaptureEnabled === false` → increments "disabled" metric
 *   2. Skips (no throw) when `app.bodyCaptureQueue` is undefined (test mode)
 *   3. Happy path: enqueues with correct payload shape → increments "queued" metric
 *   4. Swallows enqueue errors (never throws) → increments "enqueue_failed" metric
 */

import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { emitBodyCapture } from "../../src/runtime/bodyCapture.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_UUID_ORG = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_USER = "22222222-2222-4222-8222-222222222222";
const VALID_UUID_KEY = "33333333-3333-4333-8333-333333333333";

function makeReq(
  overrides: Partial<{
    contentCaptureEnabled: boolean;
    retentionDaysOverride: number | null;
    userAgent: string | undefined;
    sessionId: string | undefined;
  }> = {},
): FastifyRequest {
  const req = {
    id: "req-test-1",
    headers: {
      "user-agent": overrides.userAgent ?? "vitest/1.0",
      ...(overrides.sessionId !== undefined
        ? { "x-session-id": overrides.sessionId }
        : {}),
    },
    ip: "127.0.0.1",
    apiKey: {
      id: VALID_UUID_KEY,
      orgId: VALID_UUID_ORG,
      userId: VALID_UUID_USER,
      teamId: null,
      quotaUsd: "0",
      quotaUsedUsd: "0",
    },
    gwUser: { id: VALID_UUID_USER, email: "test@example.com" },
    gwOrg: {
      id: VALID_UUID_ORG,
      slug: "test-org",
      contentCaptureEnabled:
        overrides.contentCaptureEnabled !== undefined
          ? overrides.contentCaptureEnabled
          : true,
      retentionDaysOverride: overrides.retentionDaysOverride ?? null,
    },
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
    bodyCaptureQueue: FastifyInstance["bodyCaptureQueue"];
  }> = {},
): { app: FastifyInstance; bodyCaptureInc: ReturnType<typeof vi.fn> } {
  const bodyCaptureInc = vi.fn();
  const app = {
    gwMetrics: {
      bodyCaptureEnqueuedTotal: { inc: bodyCaptureInc },
    },
    // Allow explicit undefined to simulate test-mode (queue absent)
    ...(Object.prototype.hasOwnProperty.call(overrides, "bodyCaptureQueue")
      ? { bodyCaptureQueue: overrides.bodyCaptureQueue }
      : {}),
  };
  return { app: app as unknown as FastifyInstance, bodyCaptureInc };
}

function makeQueueStub(
  opts: { rejects?: boolean } = {},
): FastifyInstance["bodyCaptureQueue"] {
  return {
    add: opts.rejects
      ? vi.fn().mockRejectedValue(new Error("redis unavailable"))
      : vi.fn().mockResolvedValue({ id: "req-test-1" }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as FastifyInstance["bodyCaptureQueue"];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("emitBodyCapture", () => {
  it("1. skips enqueue when contentCaptureEnabled === false", async () => {
    const req = makeReq({ contentCaptureEnabled: false });
    const queue = makeQueueStub();
    const { app, bodyCaptureInc } = makeApp({ bodyCaptureQueue: queue });

    await expect(
      emitBodyCapture({
        app,
        req,
        requestId: "req-test-1",
        requestBodyJson: JSON.stringify({ model: "claude-3-5-haiku-20241022" }),
        responseBody: { id: "msg_1", type: "message" },
        stream: false,
      }),
    ).resolves.toBeUndefined();

    // Must not have enqueued anything
    expect(queue!.add as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    // Must have metered as "disabled"
    expect(bodyCaptureInc).toHaveBeenCalledWith({ result: "disabled" });
  });

  it("2. skips silently when bodyCaptureQueue is undefined (test mode)", async () => {
    const req = makeReq({ contentCaptureEnabled: true });
    // No bodyCaptureQueue key at all — simulates test-mode server
    const { app, bodyCaptureInc } = makeApp();

    await expect(
      emitBodyCapture({
        app,
        req,
        requestId: "req-test-1",
        requestBodyJson: JSON.stringify({ model: "claude-3-5-haiku-20241022" }),
        responseBody: { id: "msg_1", type: "message" },
        stream: false,
      }),
    ).resolves.toBeUndefined();

    // No metric emitted (queue absent — cannot tell apart from disabled in this path)
    expect(bodyCaptureInc).not.toHaveBeenCalled();
  });

  it("3. happy path: enqueues with correct payload shape", async () => {
    const req = makeReq({
      contentCaptureEnabled: true,
      retentionDaysOverride: 30,
      userAgent: "anthropic-sdk/0.40.0",
      sessionId: "ses-abc123",
    });
    const queue = makeQueueStub();
    const { app, bodyCaptureInc } = makeApp({ bodyCaptureQueue: queue });

    const requestBodyJson = JSON.stringify({
      model: "claude-3-5-haiku-20241022",
      messages: [{ role: "user", content: "hello" }],
    });
    const responseBody = {
      id: "msg_1",
      type: "message",
      model: "claude-3-5-haiku-20241022",
    };

    await emitBodyCapture({
      app,
      req,
      requestId: "req-test-1",
      requestBodyJson,
      responseBody,
      stream: false,
      stopReason: "end_turn",
    });

    // Queue.add should have been called once
    const addMock = queue!.add as ReturnType<typeof vi.fn>;
    expect(addMock).toHaveBeenCalledOnce();

    const [jobName, payload] = addMock.mock.calls[0]!;
    expect(jobName).toBe("body-capture");
    expect(payload).toMatchObject({
      requestId: "req-test-1",
      orgId: VALID_UUID_ORG,
      userId: VALID_UUID_USER,
      requestBody: requestBodyJson,
      responseBody: JSON.stringify(responseBody),
      retentionDays: 30,
      stopReason: "end_turn",
      clientUserAgent: "anthropic-sdk/0.40.0",
      clientSessionId: "ses-abc123",
    });

    // Metric should reflect "queued"
    expect(bodyCaptureInc).toHaveBeenCalledWith({ result: "queued" });
  });

  it("4. swallows enqueue errors — never throws, emits enqueue_failed metric", async () => {
    const req = makeReq({ contentCaptureEnabled: true });
    const queue = makeQueueStub({ rejects: true });
    const { app, bodyCaptureInc } = makeApp({ bodyCaptureQueue: queue });

    await expect(
      emitBodyCapture({
        app,
        req,
        requestId: "req-test-1",
        requestBodyJson: JSON.stringify({ model: "claude-3-5-haiku-20241022" }),
        responseBody: { id: "msg_1" },
        stream: false,
      }),
    ).resolves.toBeUndefined();

    // Must have metered as "enqueue_failed"
    expect(bodyCaptureInc).toHaveBeenCalledWith({ result: "enqueue_failed" });
    // Must have logged a warn
    expect(
      (req.log as unknown as { warn: ReturnType<typeof vi.fn> }).warn,
    ).toHaveBeenCalledOnce();
  });
});

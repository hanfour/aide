import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JobsOptions } from "bullmq";
import {
  enqueueUsageLog,
  UsageLogJobPayload,
  USAGE_LOG_JOB_NAME,
  USAGE_LOG_QUEUE_NAME,
  USAGE_LOG_QUEUE_PREFIX,
  USAGE_LOG_DEFAULT_JOB_OPTIONS,
  type QueueLike,
} from "../../src/workers/usageLogQueue.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_UUID_1 = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_2 = "22222222-2222-4222-8222-222222222222";
const VALID_UUID_3 = "33333333-3333-4333-8333-333333333333";
const VALID_UUID_4 = "44444444-4444-4444-8444-444444444444";

function validPayload(
  overrides: Partial<UsageLogJobPayload> = {},
): UsageLogJobPayload {
  return {
    requestId: "req_abcdef123",
    userId: VALID_UUID_1,
    apiKeyId: VALID_UUID_2,
    accountId: VALID_UUID_3,
    orgId: VALID_UUID_4,
    teamId: null,
    requestedModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5-20250101",
    platform: "anthropic",
    surface: "messages",
    stream: false,
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    inputCost: "0.0030000000",
    outputCost: "0.0090000000",
    cacheCreationCost: "0",
    cacheReadCost: "0",
    totalCost: "0.0120000000",
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    statusCode: 200,
    durationMs: 1234,
    firstTokenMs: null,
    bufferReleasedAtMs: null,
    upstreamRetries: 0,
    failedAccountIds: [],
    userAgent: null,
    ipAddress: null,
    ...overrides,
  };
}

interface RecordedAdd {
  name: string;
  data: UsageLogJobPayload;
  opts: JobsOptions | undefined;
}

function makeFakeQueue(returnValue: unknown = { id: "stub-job-id" }): {
  queue: QueueLike;
  calls: RecordedAdd[];
  add: ReturnType<typeof vi.fn>;
} {
  const calls: RecordedAdd[] = [];
  const add = vi.fn(
    async (name: string, data: UsageLogJobPayload, opts?: JobsOptions) => {
      calls.push({ name, data, opts });
      return returnValue;
    },
  );
  return { queue: { add }, calls, add };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("usageLogQueue constants", () => {
  it("exports the design-doc queue identifier as prefix + name", () => {
    // The full Redis namespace BullMQ writes to is `${prefix}:${name}:*` —
    // verify the two halves combine to "aide:gw:usage-log".
    expect(`${USAGE_LOG_QUEUE_PREFIX}:${USAGE_LOG_QUEUE_NAME}`).toBe(
      "aide:gw:usage-log",
    );
  });

  it("default job options enforce attempts=3 + exponential 1000ms backoff", () => {
    expect(USAGE_LOG_DEFAULT_JOB_OPTIONS.attempts).toBe(3);
    expect(USAGE_LOG_DEFAULT_JOB_OPTIONS.backoff).toEqual({
      type: "exponential",
      delay: 1000,
    });
  });

  it("default job options retain failed jobs for 24h, completed for 1h", () => {
    expect(USAGE_LOG_DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual({
      age: 3600,
      count: 1000,
    });
    expect(USAGE_LOG_DEFAULT_JOB_OPTIONS.removeOnFail).toEqual({
      age: 86400,
    });
  });
});

describe("enqueueUsageLog", () => {
  let fake: ReturnType<typeof makeFakeQueue>;

  beforeEach(() => {
    fake = makeFakeQueue();
  });

  it("passes jobId = payload.requestId for dedup", async () => {
    const payload = validPayload({ requestId: "req_dedup_check" });
    await enqueueUsageLog(fake.queue, payload);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.opts?.jobId).toBe("req_dedup_check");
  });

  it("passes job name = 'usage-log' and the validated data verbatim", async () => {
    const payload = validPayload();
    await enqueueUsageLog(fake.queue, payload);

    expect(fake.calls[0]!.name).toBe(USAGE_LOG_JOB_NAME);
    expect(fake.calls[0]!.data).toEqual(payload);
  });

  it("passes attempts=3, exponential backoff delay=1000", async () => {
    await enqueueUsageLog(fake.queue, validPayload());

    const opts = fake.calls[0]!.opts!;
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: "exponential", delay: 1000 });
  });

  it("passes removeOnComplete and removeOnFail retention policies", async () => {
    await enqueueUsageLog(fake.queue, validPayload());

    const opts = fake.calls[0]!.opts!;
    expect(opts.removeOnComplete).toEqual({ age: 3600, count: 1000 });
    expect(opts.removeOnFail).toEqual({ age: 86400 });
  });

  it("returns { jobId } matching payload.requestId", async () => {
    const result = await enqueueUsageLog(
      fake.queue,
      validPayload({ requestId: "req_returned_id" }),
    );
    expect(result).toEqual({ jobId: "req_returned_id" });
  });

  it("rejects payloads missing required fields (Zod validation)", async () => {
    const incomplete = { requestId: "req_x" } as unknown;
    await expect(enqueueUsageLog(fake.queue, incomplete)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("rejects payloads with non-decimal cost strings", async () => {
    const bad = validPayload({ totalCost: "not-a-number" as unknown as string });
    await expect(enqueueUsageLog(fake.queue, bad)).rejects.toThrow(
      /decimal-formatted/,
    );
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("rejects payloads with non-UUID accountId", async () => {
    const bad = validPayload({ accountId: "not-a-uuid" });
    await expect(enqueueUsageLog(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("rejects payloads with negative token counts", async () => {
    const bad = validPayload({ inputTokens: -1 });
    await expect(enqueueUsageLog(fake.queue, bad)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("accepts nullable fields (teamId, firstTokenMs, userAgent, ipAddress)", async () => {
    const payload = validPayload({
      teamId: null,
      firstTokenMs: null,
      bufferReleasedAtMs: null,
      userAgent: null,
      ipAddress: null,
    });
    await expect(enqueueUsageLog(fake.queue, payload)).resolves.toEqual({
      jobId: payload.requestId,
    });
  });

  it("propagates queue.add rejections (Redis down case)", async () => {
    const failing: QueueLike = {
      add: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    };
    await expect(
      enqueueUsageLog(failing, validPayload()),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("per-call jobOptions override defaults except jobId", async () => {
    await enqueueUsageLog(fake.queue, validPayload({ requestId: "req_ovr" }), {
      jobOptions: { attempts: 7, jobId: "ignored-by-impl" },
    });

    const opts = fake.calls[0]!.opts!;
    expect(opts.attempts).toBe(7);
    // jobId always derived from payload.requestId, never user-overridable
    expect(opts.jobId).toBe("req_ovr");
    // Other defaults still present
    expect(opts.backoff).toEqual({ type: "exponential", delay: 1000 });
  });
});

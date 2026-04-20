/**
 * BullMQ queue + thin wrapper for usage log writes (Plan 4A Part 7, Task 7.1).
 *
 * Design notes:
 *   - The plan/design doc names the queue "aide:gw:usage-log".  BullMQ namespaces
 *     keys as `<prefix>:<name>:*`, so we set prefix="aide:gw" + name="usage-log",
 *     which yields the expected `aide:gw:usage-log:*` Redis keyspace.
 *
 *   - We do NOT pass the gateway's existing `keyPrefix`-laden ioredis client to
 *     BullMQ. BullMQ's Lua scripts compute keys themselves and break when the
 *     underlying ioredis transparently re-prefixes. Pass a fresh connection
 *     (RedisOptions or a dedicated Redis instance) when constructing the Queue.
 *
 *   - The job payload carries pre-computed cost decimals as strings. The route
 *     handler already has tokens + model + multipliers; computing cost there
 *     keeps pricing close to the request and lets the future worker (Task 7.2)
 *     stay a pure batched DB writer (insert + quota update). Decimals are passed
 *     as strings so they survive JSON round-trip without float drift.
 *
 *   - This module exports a `QueueLike` interface so unit tests can inject a
 *     fake. End-to-end queue behaviour (Lua scripts, deduplication via Redis)
 *     is exercised in the worker integration test (Task 7.2).
 */

import { Queue, type JobsOptions, type RedisOptions } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";

// ── Constants ────────────────────────────────────────────────────────────────

/** BullMQ queue name (without prefix). */
export const USAGE_LOG_QUEUE_NAME = "usage-log";

/**
 * BullMQ key prefix. Combined with the queue name, this produces Redis keys
 * under `aide:gw:usage-log:*`, matching the design-doc identifier
 * "aide:gw:usage-log".
 */
export const USAGE_LOG_QUEUE_PREFIX = "aide:gw";

/** BullMQ job name used for every usage-log write. */
export const USAGE_LOG_JOB_NAME = "usage-log";

/** Default retry / retention policy for usage-log jobs. */
export const USAGE_LOG_DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
} as const satisfies JobsOptions;

// ── Payload schema ───────────────────────────────────────────────────────────

const UUID = z.string().uuid();

/**
 * Decimal-string for cost columns. usage_logs cost columns are
 * `decimal(20, 10)` — Postgres rejects non-numeric strings, so validate format
 * before enqueue. Allows optional leading minus (refunds / corrections), an
 * integer part, and optional fractional part.
 */
const DECIMAL_STRING = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "must be a decimal-formatted string");

const NON_NEGATIVE_INT = z.number().int().nonnegative();
const STATUS_CODE = z.number().int().min(100).max(599);

/**
 * Job payload validated at enqueue time. Mirrors the columns of usage_logs the
 * worker needs to insert + the api_keys.quota_used_usd update.
 */
export const UsageLogJobPayload = z.object({
  // Identity / scope
  requestId: z.string().min(1),
  userId: UUID,
  apiKeyId: UUID,
  accountId: UUID,
  orgId: UUID,
  teamId: UUID.nullable(),

  // Request shape
  requestedModel: z.string().min(1),
  upstreamModel: z.string().min(1),
  platform: z.string().min(1),
  surface: z.string().min(1),
  stream: z.boolean(),

  // Token counts
  inputTokens: NON_NEGATIVE_INT,
  outputTokens: NON_NEGATIVE_INT,
  cacheCreationTokens: NON_NEGATIVE_INT,
  cacheReadTokens: NON_NEGATIVE_INT,

  // Pre-computed cost decimals (worker just inserts these verbatim)
  inputCost: DECIMAL_STRING,
  outputCost: DECIMAL_STRING,
  cacheCreationCost: DECIMAL_STRING,
  cacheReadCost: DECIMAL_STRING,
  totalCost: DECIMAL_STRING,

  // Pricing multipliers in effect at request time (audit trail)
  rateMultiplier: DECIMAL_STRING,
  accountRateMultiplier: DECIMAL_STRING,

  // Outcome / timing
  statusCode: STATUS_CODE,
  durationMs: NON_NEGATIVE_INT,
  firstTokenMs: NON_NEGATIVE_INT.nullable(),
  bufferReleasedAtMs: NON_NEGATIVE_INT.nullable(),
  upstreamRetries: NON_NEGATIVE_INT,
  failedAccountIds: z.array(UUID),

  // Client metadata (nullable — depends on trust-proxy chain + UA presence)
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
});

export type UsageLogJobPayload = z.infer<typeof UsageLogJobPayload>;

// ── Queue interface (for DI in tests) ────────────────────────────────────────

/**
 * Subset of BullMQ's Queue API that this module depends on. Exposed so unit
 * tests can swap in a fake without standing up a real Redis-backed queue.
 */
export interface QueueLike {
  add(
    name: string,
    data: UsageLogJobPayload,
    opts?: JobsOptions,
  ): Promise<{ id?: string | undefined } | unknown>;
  close?(): Promise<void>;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Connection input accepted by `createUsageLogQueue`.
 *
 * Pass either a fresh ioredis instance (must NOT have the gateway's
 * `keyPrefix` set — see file-level note) or `RedisOptions` and let BullMQ
 * manage the connection.
 */
export type UsageLogQueueConnection = Redis | RedisOptions;

export interface CreateUsageLogQueueOptions {
  connection: UsageLogQueueConnection;
  /** Override prefix (default `USAGE_LOG_QUEUE_PREFIX`). Useful in tests. */
  prefix?: string;
  /** Override default job options. Merged shallowly over the module defaults. */
  defaultJobOptions?: JobsOptions;
}

/**
 * Build a real BullMQ Queue wired to `aide:gw:usage-log:*`.
 *
 * The returned instance satisfies `QueueLike` — callers may pass it directly
 * to `enqueueUsageLog`.
 */
export function createUsageLogQueue(
  opts: CreateUsageLogQueueOptions,
): Queue<UsageLogJobPayload> {
  return new Queue<UsageLogJobPayload>(USAGE_LOG_QUEUE_NAME, {
    connection: opts.connection,
    prefix: opts.prefix ?? USAGE_LOG_QUEUE_PREFIX,
    defaultJobOptions: {
      ...USAGE_LOG_DEFAULT_JOB_OPTIONS,
      ...(opts.defaultJobOptions ?? {}),
    },
  });
}

// ── Enqueue wrapper ──────────────────────────────────────────────────────────

export interface EnqueueUsageLogResult {
  /** The BullMQ job ID — equals `payload.requestId` for dedup. */
  jobId: string;
}

export interface EnqueueUsageLogOptions {
  /**
   * Extra per-call BullMQ options. Shallow-merged on top of the module
   * defaults (incl. `jobId` derived from the payload). Provided primarily for
   * tests / future fallback paths; production callers should pass nothing.
   */
  jobOptions?: JobsOptions;
}

/**
 * Validate `payload` and enqueue it onto the BullMQ queue.
 *
 * - jobId is set to `payload.requestId` so duplicate enqueues for the same
 *   request are no-ops (BullMQ rejects duplicate job IDs and returns the
 *   existing job).
 * - On Zod validation failure this throws — callers should treat that as a
 *   programmer error (the route assembled a bad payload), not a transient
 *   condition. Surface the ZodError details in logs.
 * - On Redis-side failure the underlying `queue.add` rejection bubbles out.
 *   The future Task 7.3 inline-DB-fallback path is the right place to catch
 *   that and write the row directly.
 */
export async function enqueueUsageLog(
  queue: QueueLike,
  payload: unknown,
  opts: EnqueueUsageLogOptions = {},
): Promise<EnqueueUsageLogResult> {
  const validated = UsageLogJobPayload.parse(payload);
  const jobOptions: JobsOptions = {
    ...USAGE_LOG_DEFAULT_JOB_OPTIONS,
    ...(opts.jobOptions ?? {}),
    jobId: validated.requestId,
  };
  await queue.add(USAGE_LOG_JOB_NAME, validated, jobOptions);
  return { jobId: validated.requestId };
}

/**
 * Shared helpers for wiring `enqueueUsageLog` into the non-streaming route
 * handlers (Plan 4A Part 7, Sub-task B).
 *
 * Responsibilities:
 *   - Cache the pricing map at module scope so `loadPricing()` runs once per
 *     process (disk read) rather than per request.
 *   - Extract token counts from a parsed Anthropic response shape in one place
 *     so messages.ts + chatCompletions.ts stay in lockstep.
 *   - Build the fully-validated `UsageLogJobPayload` object from everything
 *     the route already has in scope (req, body, account, parsed upstream
 *     response, timing).
 *   - Encapsulate the "enqueue-or-warn" pattern — when `app.usageLogQueue` is
 *     decorated (production), enqueue via BullMQ with the inline DB fallback
 *     wired; when absent (test mode — see server.ts BuildOpts.redis), log at
 *     debug and skip. Any residual error from `enqueueUsageLog` (meaning BOTH
 *     BullMQ AND inline-DB fallback failed) is logged but NOT re-thrown so
 *     the user-facing response is never blocked by usage-log persistence.
 *
 * This module is imported by both `routes/messages.ts` (non-streaming branch)
 * and `routes/chatCompletions.ts`. Streaming on `/v1/messages` wires its own
 * variant (Sub-task C) that captures firstTokenMs / bufferReleasedAtMs.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  loadPricing,
  resolveCost,
  type PricingMap,
  type CostBreakdown,
} from "@aide/gateway-core";
import {
  enqueueUsageLog,
  type UsageLogJobPayload,
} from "../workers/usageLogQueue.js";

// ── Pricing cache ────────────────────────────────────────────────────────────

/**
 * Pricing map is loaded lazily on first access and cached for the process
 * lifetime.  `loadPricing()` reads `packages/gateway-core/pricing/litellm.json`
 * synchronously from disk — acceptable at boot, wasteful per-request.
 *
 * Exported as a getter (not a top-level const) so (a) tests that stub the
 * filesystem can reset via `resetPricingCacheForTests()`, and (b) the cost of
 * the first disk read is deferred past module import.
 */
let cachedPricing: PricingMap | null = null;

export function getPricing(): PricingMap {
  if (cachedPricing === null) {
    cachedPricing = loadPricing();
  }
  return cachedPricing;
}

/**
 * Test-only hook: clears the cached pricing map so the next `getPricing()`
 * call re-reads from disk. Not exported from the package surface; internal
 * tests import it directly.
 */
export function resetPricingCacheForTests(): void {
  cachedPricing = null;
}

// ── Token extraction ─────────────────────────────────────────────────────────

/**
 * Shape we read off a parsed Anthropic Messages response. The real type is
 * `AnthropicMessagesResponse` from `@aide/gateway-core`, but we accept
 * `unknown` and narrow defensively because the body arrived across the wire
 * and must never trust its shape.
 */
export interface ExtractedUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Safely extract usage + model from a parsed upstream Anthropic response.
 *
 * Returns a fully-populated `ExtractedUsage` with zero-filled token fields
 * when the upstream omits them, and an empty-string model when the upstream
 * omits `model`. Callers treat empty `model` as a pricing miss (which is the
 * same bucket as "unknown model" semantically).
 *
 * Never throws — a malformed upstream response becomes an all-zero usage
 * record plus empty model, which still produces a valid row for forensics.
 */
export function extractUsageFromAnthropicResponse(
  parsed: unknown,
): ExtractedUsage {
  if (!parsed || typeof parsed !== "object") {
    return {
      model: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const usage =
    obj.usage && typeof obj.usage === "object"
      ? (obj.usage as Record<string, unknown>)
      : {};
  return {
    model: typeof obj.model === "string" ? obj.model : "",
    inputTokens: toNonNegInt(usage.input_tokens),
    outputTokens: toNonNegInt(usage.output_tokens),
    cacheCreationTokens: toNonNegInt(usage.cache_creation_input_tokens),
    cacheReadTokens: toNonNegInt(usage.cache_read_input_tokens),
  };
}

function toNonNegInt(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

// ── Payload builder ──────────────────────────────────────────────────────────

export interface BuildUsageLogPayloadInput {
  req: FastifyRequest;
  /** Client-requested model (e.g., `body.model` from the inbound request). */
  requestedModel: string;
  accountId: string;
  /** Parsed upstream Anthropic response body (used for usage + upstreamModel). */
  upstreamResponse: unknown;
  /** "anthropic" for /v1/messages, "openai" for /v1/chat/completions. */
  platform: "anthropic" | "openai";
  /** "messages" for /v1/messages, "chat-completions" for /v1/chat/completions. */
  surface: "messages" | "chat-completions";
  /** HTTP status code sent downstream to the client. */
  statusCode: number;
  /** Wall-clock ms since the request started (route handler entry). */
  durationMs: number;
  /** Pre-loaded pricing map (pass `getPricing()`). */
  pricing: PricingMap;
  /**
   * True when the client opted into SSE streaming (`stream=true`).  Drives
   * the `usage_logs.stream` column.  Defaults to `false` for backward
   * compatibility with non-streaming callers.
   */
  stream?: boolean;
  /**
   * Streaming only — ms between request start and the first upstream byte
   * the gateway observed. `null` when the upstream emitted zero bytes.
   * Ignored when `stream === false`; non-streaming callers may omit.
   */
  firstTokenMs?: number | null;
  /**
   * Streaming only — ms between request start and the moment `SmartBuffer`
   * committed (transitioned BUFFERING → COMMITTED) and began flushing bytes
   * to the client. `null` when the buffer never committed (e.g., zero-byte
   * upstream stream). Ignored when `stream === false`.
   */
  bufferReleasedAtMs?: number | null;
}

export interface BuildUsageLogPayloadResult {
  payload: UsageLogJobPayload;
  cost: CostBreakdown;
}

/**
 * Assemble the full `UsageLogJobPayload` for a successful non-streaming
 * request. Computes cost via the injected pricing map; when the map misses
 * the upstream model, cost decimals are zero and `cost.miss === true` (the
 * caller should bump `gw_pricing_miss_total` + log a warning).
 *
 * Placeholders per Sub-task B handoff doc:
 *   - `rateMultiplier` and `accountRateMultiplier` default to `"1.0000"`
 *     until per-key/per-account markup policy lands.
 *   - `upstreamRetries` is `0` and `failedAccountIds` is `[]` until the
 *     failover loop exposes those counters.
 *
 * Streaming-only fields are set to null:
 *   - `firstTokenMs` (time to first SSE chunk)
 *   - `bufferReleasedAtMs` (time the smart-buffer commit fired)
 */
export function buildUsageLogPayload(
  input: BuildUsageLogPayloadInput,
): BuildUsageLogPayloadResult {
  const usage = extractUsageFromAnthropicResponse(input.upstreamResponse);
  const cost = resolveCost(input.pricing, usage.model, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
  });

  // The apiKey / gwUser decorations are populated by apiKeyAuthPlugin which
  // rejects with 401 before the route handler runs; the bang assertions
  // match the defense-in-depth check at the top of each route.
  const apiKey = input.req.apiKey!;
  const gwUser = input.req.gwUser!;

  const payload: UsageLogJobPayload = {
    requestId: input.req.id,
    userId: gwUser.id,
    apiKeyId: apiKey.id,
    accountId: input.accountId,
    orgId: apiKey.orgId,
    teamId: apiKey.teamId ?? null,
    requestedModel: input.requestedModel,
    upstreamModel: usage.model,
    platform: input.platform,
    surface: input.surface,
    stream: input.stream ?? false,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    inputCost: cost.inputCost.toFixed(10),
    outputCost: cost.outputCost.toFixed(10),
    cacheCreationCost: cost.cacheCreationCost.toFixed(10),
    cacheReadCost: cost.cacheReadCost.toFixed(10),
    totalCost: cost.totalCost.toFixed(10),
    rateMultiplier: "1.0000",
    accountRateMultiplier: "1.0000",
    statusCode: input.statusCode,
    durationMs: input.durationMs,
    // Streaming-only fields. Non-streaming callers omit them (defaults below)
    // and the non-null shape of the `usage_logs` columns tolerates null via
    // the bigserial/integer nullability declared in the schema.
    firstTokenMs: input.stream === true ? (input.firstTokenMs ?? null) : null,
    bufferReleasedAtMs:
      input.stream === true ? (input.bufferReleasedAtMs ?? null) : null,
    upstreamRetries: 0,
    failedAccountIds: [],
    userAgent:
      typeof input.req.headers["user-agent"] === "string"
        ? input.req.headers["user-agent"]
        : null,
    // Empty-string → null: an empty `req.ip` is not a valid address and the
    // downstream persister (Postgres `inet`) would reject it anyway.
    ipAddress:
      typeof input.req.ip === "string" && input.req.ip.length > 0
        ? input.req.ip
        : null,
  };

  return { payload, cost };
}

// ── Enqueue wrapper ──────────────────────────────────────────────────────────

export interface EmitUsageLogInput {
  app: FastifyInstance;
  req: FastifyRequest;
  requestedModel: string;
  accountId: string;
  upstreamResponse: unknown;
  platform: "anthropic" | "openai";
  surface: "messages" | "chat-completions";
  statusCode: number;
  durationMs: number;
  /**
   * Streaming metadata — all optional for backward compatibility with the
   * non-streaming callers added in Sub-task B.  Streaming callers
   * (Sub-task C) pass `stream: true` and the two ms fields measured against
   * the same `startedAtMs` used to compute `durationMs`.
   */
  stream?: boolean;
  firstTokenMs?: number | null;
  bufferReleasedAtMs?: number | null;
}

/**
 * Build the payload and enqueue it, handling:
 *   - Test mode (`app.usageLogQueue` undefined → log at debug, skip).
 *   - Pricing misses (warn + bump `gw_pricing_miss_total`; still enqueue
 *     with zero-cost so operators see the row).
 *   - BullMQ enqueue + inline-fallback both failed (warn at the route; the
 *     structured `gw_usage_persist_lost` log + metric already fired inside
 *     `enqueueUsageLog`). NEVER re-throws — usage-log persistence must not
 *     fail a successful user request.
 *
 * Synchronous on the happy path (BullMQ `queue.add` is a Redis publish,
 * sub-ms); on Redis failure, the inline DB fallback runs synchronously so
 * the row is committed before the route returns.
 */
export async function emitUsageLog(input: EmitUsageLogInput): Promise<void> {
  const { app, req } = input;
  // Top-level try/catch enforces the documented never-throws contract:
  // a successful upstream response must never surface as a 500 to the
  // client because of a usage-log-emission failure. This wraps EVERY
  // code path — `getPricing()` (disk-read on first call), the synchronous
  // `buildUsageLogPayload`, the pricing-miss metering, AND the enqueue
  // — so any thrown error lands here and is logged, not propagated.
  try {
    const { payload, cost } = buildUsageLogPayload({
      req,
      requestedModel: input.requestedModel,
      accountId: input.accountId,
      upstreamResponse: input.upstreamResponse,
      platform: input.platform,
      surface: input.surface,
      statusCode: input.statusCode,
      durationMs: input.durationMs,
      pricing: getPricing(),
      stream: input.stream,
      firstTokenMs: input.firstTokenMs,
      bufferReleasedAtMs: input.bufferReleasedAtMs,
    });

    if (cost.miss) {
      // Bump the counter using the upstream-reported model (empty string when
      // the upstream omitted it — still a valid label value for the counter).
      app.gwMetrics.pricingMissTotal.inc({ model: payload.upstreamModel });
      req.log.warn(
        {
          requestId: payload.requestId,
          upstreamModel: payload.upstreamModel,
          requestedModel: payload.requestedModel,
        },
        "pricing miss — usage log row will record zero cost",
      );
    }

    if (!app.usageLogQueue) {
      // Test mode (server.ts skips BullMQ when opts.redis is injected).
      req.log.debug(
        { requestId: payload.requestId },
        "usage log queue absent; skipping enqueue (test mode)",
      );
      return;
    }

    try {
      await enqueueUsageLog(app.usageLogQueue, payload, {
        fallback: {
          db: app.db,
          logger: req.log,
          // Direct Counter ref — satisfies UsageLogFallbackMetrics via `.inc()`.
          metrics: app.gwMetrics.usagePersistLostTotal,
        },
      });
    } catch (enqueueErr) {
      // BullMQ failed AND inline fallback also failed. The structured
      // `gw_usage_persist_lost` log + metric already happened inside
      // `enqueueUsageLog`. Don't fail the user request — just acknowledge.
      req.log.warn(
        {
          err:
            enqueueErr instanceof Error
              ? enqueueErr.message
              : String(enqueueErr),
          requestId: payload.requestId,
        },
        "usage log persist failed (already metered as gw_usage_persist_lost)",
      );
    }
  } catch (err) {
    // Something upstream of the enqueue failed — pricing load, payload
    // construction, or metric increment. Record it and return without
    // throwing so the user's successful response is unaffected.
    req.log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        requestId: req.id,
      },
      "usage log emit failed; user request unaffected",
    );
  }
}

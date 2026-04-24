/**
 * Emits a best-effort body capture job onto the BullMQ body-capture queue.
 *
 * Mirrors the never-throws contract of `emitUsageLog` — any failure (queue
 * absent in test mode, contentCaptureEnabled=false, Redis error) is swallowed
 * and metered, never propagated to the caller.
 *
 * Plan 4B Part 3, Task 3.5.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { enqueueBodyCapture } from "../workers/bodyCaptureQueue.js";

/** Default retention period when no org-level override is configured. */
const DEFAULT_RETENTION_DAYS = 90;

export interface EmitBodyCaptureInput {
  app: FastifyInstance;
  req: FastifyRequest;
  /** The same request ID used in the paired emitUsageLog call. */
  requestId: string;
  /** Already-serialised request body (same Buffer used for upstream). */
  requestBodyJson: string;
  /**
   * For non-streaming paths: the parsed Anthropic response object.
   * For streaming paths: the assembled StreamTranscript from StreamUsageExtractor
   * (same Anthropic message shape — id, type, role, model, content, stop_reason, usage).
   * Partial transcripts are valid when the stream was cut mid-message.
   */
  responseBody: unknown;
  /** True if the request was a streaming request. */
  stream: boolean;
  stopReason?: string | null;
  attemptErrors?: string | null;
  requestParams?: unknown;
  attachmentsMeta?: unknown;
  cacheControlMarkers?: unknown;
  thinkingBody?: string | null;
}

/**
 * Assemble a body-capture payload and enqueue it, gated on
 * `req.gwOrg.contentCaptureEnabled`. Never throws — all errors are caught,
 * logged at warn, and metered via `gw_body_capture_enqueued_total`.
 *
 * Streaming transcript (Plan 4B Task 3.5b — resolved):
 *   For streaming responses, `responseBody` is the assembled StreamTranscript
 *   produced by `StreamUsageExtractor.getAssembledTranscript()`. Partial
 *   transcripts (stream cut mid-message) are captured as-is — null fields
 *   indicate events that never arrived.
 */
export async function emitBodyCapture(
  input: EmitBodyCaptureInput,
): Promise<void> {
  const { app, req } = input;
  try {
    if (!req.gwOrg?.contentCaptureEnabled) {
      app.gwMetrics.bodyCaptureEnqueuedTotal.inc({ result: "disabled" });
      return;
    }

    if (!app.bodyCaptureQueue) {
      // Test mode or queue disabled — silently skip (no metric: queue is
      // not available to increment against in unit tests).
      return;
    }

    const retentionDays =
      req.gwOrg.retentionDaysOverride ?? DEFAULT_RETENTION_DAYS;

    const responseBodyJson =
      typeof input.responseBody === "string"
        ? input.responseBody
        : JSON.stringify(input.responseBody);

    await enqueueBodyCapture(app.bodyCaptureQueue, {
      requestId: input.requestId,
      orgId: req.gwOrg.id,
      userId: req.apiKey?.userId ?? "",
      requestBody: input.requestBodyJson,
      responseBody: responseBodyJson,
      thinkingBody: input.thinkingBody ?? null,
      attemptErrors: input.attemptErrors ?? null,
      requestParams: input.requestParams ?? null,
      stopReason: input.stopReason ?? null,
      clientUserAgent: extractUserAgent(req),
      clientSessionId: extractSessionId(req),
      attachmentsMeta: input.attachmentsMeta ?? null,
      cacheControlMarkers: input.cacheControlMarkers ?? null,
      retentionDays,
    });

    app.gwMetrics.bodyCaptureEnqueuedTotal.inc({ result: "queued" });
  } catch (err) {
    app.gwMetrics.bodyCaptureEnqueuedTotal.inc({ result: "enqueue_failed" });
    req.log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        requestId: input.requestId,
      },
      "body capture enqueue failed (best-effort)",
    );
  }
}

function extractUserAgent(req: FastifyRequest): string | null {
  const h = req.headers["user-agent"];
  return typeof h === "string" ? h : null;
}

function extractSessionId(req: FastifyRequest): string | null {
  const h = req.headers["x-session-id"];
  return typeof h === "string" ? h : null;
}

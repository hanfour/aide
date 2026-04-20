import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerEnv } from "@aide/config";
import {
  runFailover,
  AllUpstreamsFailed,
  FatalUpstreamError,
} from "../runtime/failoverLoop.js";
import { resolveCredential } from "../runtime/resolveCredential.js";
import { maybeRefreshOAuth } from "../runtime/oauthRefresh.js";
import { callUpstreamMessages } from "../runtime/upstreamCall.js";
import { acquireSlot, releaseSlot } from "../redis/slots.js";
import { SmartBuffer } from "../runtime/smartBuffer.js";
import type { SelectedAccount } from "../runtime/selectAccount.js";

export interface MessagesRouteOptions {
  env: ServerEnv;
}

/** Safety-net expiry: slot key expires in Redis even if release is missed. */
const SLOT_DURATION_MS = 60_000;

const HOP_BY_HOP = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
]);

/**
 * Thrown from within the attempt callback when no concurrency slot is available.
 * Classified as a fatal "capacity" error so the outer catch can produce a 503
 * with the expected `account_at_capacity` error code.
 */
class CapacityError extends Error {
  constructor() {
    super("account_at_capacity");
    this.name = "CapacityError";
  }
}

export async function messagesRoutes(
  app: FastifyInstance,
  opts: MessagesRouteOptions,
): Promise<void> {
  app.post("/v1/messages", async (req: FastifyRequest, reply: FastifyReply) => {
    // apiKeyAuthPlugin should have already rejected unauthenticated requests.
    // Defense-in-depth: verify decorations are present.
    if (!req.apiKey || !req.gwUser || !req.gwOrg) {
      reply.code(401).send({ error: "missing_api_key" });
      return;
    }

    // Body — Fastify auto-parses application/json before this handler runs.
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }

    // Step 2 early-exit: model must be present before any DB/Redis work.
    if (typeof body.model !== "string" || body.model.length === 0) {
      reply.code(400).send({ error: "missing_model" });
      return;
    }

    const isStream = body.stream === true;
    const requestId = req.id; // Fastify auto-generates UUID per request.
    const upstreamBodyBuf = Buffer.from(JSON.stringify(body));

    // Wire AbortSignal from client disconnect.
    const ac = new AbortController();
    const onClose = () => ac.abort();
    req.raw.once("close", onClose);

    try {
      if (isStream) {
        await runStreamingFailover(
          app,
          opts,
          req,
          reply,
          upstreamBodyBuf,
          requestId,
          ac.signal,
        );
      } else {
        await runNonStreamFailover(
          app,
          opts,
          req,
          reply,
          upstreamBodyBuf,
          requestId,
          ac.signal,
        );
      }
    } catch (err) {
      // After hijack (streaming), we own reply.raw and must not call reply.send.
      if (reply.raw.headersSent) {
        return;
      }
      if (err instanceof CapacityError) {
        reply.code(503).send({ error: "account_at_capacity" });
        return;
      }
      if (err instanceof AllUpstreamsFailed) {
        // attemptedIds is empty when no candidates existed at all.
        const errorCode =
          err.attemptedIds.length === 0
            ? "no_upstream_available"
            : "all_upstreams_failed";
        reply.code(503).send({
          error: errorCode,
          ...(err.attemptedIds.length > 0 && {
            attempted_count: err.attemptedIds.length,
          }),
          request_id: requestId,
        });
        return;
      }
      if (err instanceof FatalUpstreamError) {
        reply.code(err.statusCode).send({
          error: err.reason,
          request_id: requestId,
        });
        return;
      }
      throw err;
    } finally {
      req.raw.off("close", onClose);
    }
  });
}

async function runNonStreamFailover(
  app: FastifyInstance,
  opts: MessagesRouteOptions,
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamBodyBuf: Buffer,
  requestId: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await runFailover({
    db: app.db,
    orgId: req.apiKey!.orgId,
    teamId: req.apiKey!.teamId,
    maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
    attempt: async (account: SelectedAccount) => {
      const acquired = await acquireSlot(
        app.redis,
        "account",
        account.id,
        requestId,
        account.concurrency,
        SLOT_DURATION_MS,
      );
      if (!acquired) {
        throw new CapacityError();
      }
      try {
        let credential = await resolveCredential(app.db, account.id, {
          masterKeyHex: opts.env.CREDENTIAL_ENCRYPTION_KEY!,
        });
        if (credential.type === "oauth") {
          credential = await maybeRefreshOAuth(
            app.db,
            app.redis,
            account.id,
            credential,
            {
              masterKeyHex: opts.env.CREDENTIAL_ENCRYPTION_KEY!,
              leadMinutes: opts.env.GATEWAY_OAUTH_REFRESH_LEAD_MIN,
              maxFail: opts.env.GATEWAY_OAUTH_MAX_FAIL,
            },
          );
        }
        // TODO(part-6): wait queue admission control
        // TODO(part-6): sticky session lookup
        // TODO(part-6): idempotency cache check
        // TODO(part-7): usage_logs INSERT + api_keys.quota_used_usd UPDATE in same transaction

        const upstream = await callUpstreamMessages({
          baseUrl: opts.env.UPSTREAM_ANTHROPIC_BASE_URL,
          body: upstreamBodyBuf,
          credential,
          signal,
        });

        if (upstream.kind === "stream") {
          // Defensive guard: stream=true was gated above; upstream should not
          // return SSE for a non-streaming request.
          throw { status: 502, message: "unexpected_stream" };
        }

        if (upstream.status >= 400 && upstream.status < 500) {
          // 4xx errors are client errors — forward them directly without failover.
          return upstream;
        }

        if (upstream.status < 200 || upstream.status >= 300) {
          // 5xx / unexpected non-2xx → failover-eligible transient error.
          const text = upstream.body.toString("utf8");
          const ra = parseRetryAfter(upstream.headers["retry-after"]);
          throw {
            status: upstream.status,
            retryAfter: ra,
            message: text.slice(0, 500),
          };
        }

        return upstream;
      } finally {
        await releaseSlot(app.redis, "account", account.id, requestId).catch(
          () => {
            // Intentionally swallowed — slot expires on its own within SLOT_DURATION_MS.
          },
        );
      }
    },
  });

  // Forward upstream status code.
  reply.code(result.status);

  // Forward relevant response headers; strip hop-by-hop headers.
  for (const [k, v] of Object.entries(result.headers)) {
    if (typeof v === "undefined") continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    reply.header(k, v as string);
  }

  reply.send(result.body);
}

async function runStreamingFailover(
  app: FastifyInstance,
  opts: MessagesRouteOptions,
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamBodyBuf: Buffer,
  requestId: string,
  signal: AbortSignal,
): Promise<void> {
  // Take over the response — Fastify will not auto-send.
  reply.hijack();

  await runFailover({
    db: app.db,
    orgId: req.apiKey!.orgId,
    teamId: req.apiKey!.teamId,
    maxSwitches: opts.env.GATEWAY_MAX_ACCOUNT_SWITCHES,
    attempt: async (account: SelectedAccount) => {
      const acquired = await acquireSlot(
        app.redis,
        "account",
        account.id,
        requestId,
        account.concurrency,
        SLOT_DURATION_MS,
      );
      if (!acquired) {
        throw new CapacityError();
      }

      const buffer = new SmartBuffer({
        windowMs: opts.env.GATEWAY_BUFFER_WINDOW_MS,
        windowBytes: opts.env.GATEWAY_BUFFER_WINDOW_BYTES,
        onCommit: (chunks: Buffer[]) => {
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
          }
          for (const c of chunks) {
            reply.raw.write(c);
          }
        },
        onPassthrough: (chunk: Buffer) => {
          reply.raw.write(chunk);
        },
      });

      try {
        let credential = await resolveCredential(app.db, account.id, {
          masterKeyHex: opts.env.CREDENTIAL_ENCRYPTION_KEY!,
        });
        if (credential.type === "oauth") {
          credential = await maybeRefreshOAuth(
            app.db,
            app.redis,
            account.id,
            credential,
            {
              masterKeyHex: opts.env.CREDENTIAL_ENCRYPTION_KEY!,
              leadMinutes: opts.env.GATEWAY_OAUTH_REFRESH_LEAD_MIN,
              maxFail: opts.env.GATEWAY_OAUTH_MAX_FAIL,
            },
          );
        }

        const upstream = await callUpstreamMessages({
          baseUrl: opts.env.UPSTREAM_ANTHROPIC_BASE_URL,
          body: upstreamBodyBuf,
          credential,
          signal,
        });

        if (upstream.kind !== "stream") {
          // Upstream returned non-stream despite stream=true → treat as transient
          throw { status: 502, message: "expected_stream" };
        }

        if (upstream.status >= 400) {
          // Upstream returned an HTTP error status (4xx/5xx) for the stream request.
          // Consume the body to determine retry-after, then classify.
          const chunks: Buffer[] = [];
          for await (const c of upstream.body) {
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
          }
          const text = Buffer.concat(chunks).toString("utf8").slice(0, 500);
          const ra = parseRetryAfter(upstream.headers["retry-after"]);
          throw { status: upstream.status, retryAfter: ra, message: text };
        }

        // Stream loop — relay raw upstream SSE bytes through the smart buffer.
        for await (const chunk of upstream.body) {
          if (req.raw.destroyed) {
            // Client gone — abort upstream and exit (no failover; client is gone).
            return;
          }
          await buffer.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          );
        }

        // Upstream finished cleanly — flush any remaining buffered chunks.
        await buffer.commit();

        if (!reply.raw.headersSent) {
          // No bytes ever flushed (empty stream) — set headers and end.
          reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
        }
        reply.raw.end();
      } catch (err) {
        if (buffer.isFailoverEligible()) {
          // Pre-commit error: discard buffered chunks, propagate to failover loop.
          // Slot release is handled by the finally block below.
          buffer.discard();
          throw err;
        }
        // Post-commit error: write SSE error event, log, end stream.
        const errMsg = err instanceof Error ? err.message : String(err);
        try {
          reply.raw.write(
            `event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`,
          );
        } catch {
          // raw stream already closed — nothing we can do
        }
        try {
          reply.raw.end();
        } catch {
          // already ended
        }
        req.log.warn(
          { err: errMsg, accountId: account.id },
          "stream error after commit",
        );
      } finally {
        await releaseSlot(app.redis, "account", account.id, requestId).catch(
          () => {},
        );
      }
    },
  }).catch((err) => {
    // After hijack, AllUpstreamsFailed / FatalUpstreamError can't go through reply.send.
    // Emit error event if headers not sent yet, otherwise log only.
    if (!reply.raw.headersSent) {
      if (err instanceof CapacityError) {
        reply.raw.writeHead(503, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ error: "account_at_capacity" }));
        return;
      }
      const status = err instanceof FatalUpstreamError ? err.statusCode : 503;
      const reason =
        err instanceof FatalUpstreamError
          ? err.reason
          : err instanceof AllUpstreamsFailed && err.attemptedIds.length === 0
            ? "no_upstream_available"
            : "all_upstreams_failed";
      reply.raw.writeHead(status, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: reason, request_id: requestId }));
    } else {
      try {
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({
            error: "stream_failed",
            request_id: requestId,
          })}\n\n`,
        );
        reply.raw.end();
      } catch {
        // already closed
      }
      req.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "stream failover exhausted post-headers",
      );
    }
  });
}

function parseRetryAfter(
  raw: string | string[] | undefined,
): number | undefined {
  let val = raw;
  if (Array.isArray(val)) {
    val = val[0];
  }
  if (typeof val !== "string") return undefined;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? undefined : n;
}

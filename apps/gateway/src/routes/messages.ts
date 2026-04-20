import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerEnv } from "@aide/config";
import { selectAccounts } from "../runtime/selectAccount.js";
import { resolveCredential } from "../runtime/resolveCredential.js";
import { callUpstreamMessages } from "../runtime/upstreamCall.js";
import { acquireSlot, releaseSlot } from "../redis/slots.js";

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

    // TODO(part-6): streaming SSE support
    if (body.stream === true) {
      reply.code(501).send({
        error: "not_implemented",
        detail: "streaming arrives in Part 6",
      });
      return;
    }

    // Step 2 early-exit: model must be present before any DB/Redis work.
    if (typeof body.model !== "string" || body.model.length === 0) {
      reply.code(400).send({ error: "missing_model" });
      return;
    }

    // Step 5: account selection — returns rows with id + concurrency in one query.
    const candidates = await selectAccounts(app.db, {
      orgId: req.apiKey.orgId,
      teamId: req.apiKey.teamId,
    });
    if (candidates.length === 0) {
      reply.code(503).send({ error: "no_upstream_available" });
      return;
    }

    // TODO(part-6): failover loop — for now take only the first candidate.
    const account = candidates[0]!;
    const accountId = account.id;

    // Step 6: per-account concurrency slot via Redis ZSET.
    // TODO(part-6): user-level concurrency slot (users table has no concurrency column yet).
    const requestId = req.id; // Fastify auto-generates UUID per request.
    const acquired = await acquireSlot(
      app.redis,
      "account",
      accountId,
      requestId,
      account.concurrency,
      SLOT_DURATION_MS,
    );
    if (!acquired) {
      reply.code(503).send({ error: "account_at_capacity" });
      return;
    }

    try {
      // Step 7: decrypt credential from vault.
      const credential = await resolveCredential(app.db, accountId, {
        masterKeyHex: opts.env.CREDENTIAL_ENCRYPTION_KEY!,
      });

      // TODO(part-6): inline OAuth refresh if credential.type === "oauth" && expiresAt < now() + lead time
      // TODO(part-6): wait queue admission control
      // TODO(part-6): sticky session lookup
      // TODO(part-6): idempotency cache check
      // TODO(part-6): AbortSignal wired from req.raw close/aborted event
      // TODO(part-7): usage_logs INSERT + api_keys.quota_used_usd UPDATE in same transaction

      // Step 8: forward to upstream Anthropic endpoint.
      // req.rawBody is not available by default in Fastify (needs fastify-raw-body plugin).
      // For the non-stream MVP, JSON.stringify of the parsed body is acceptable.
      // TODO(part-6): add fastify-raw-body for byte-exact forwarding required by streaming.
      const rawBody = Buffer.from(JSON.stringify(body));

      const result = await callUpstreamMessages({
        baseUrl: opts.env.UPSTREAM_ANTHROPIC_BASE_URL,
        body: rawBody,
        credential,
      });

      if (result.kind === "stream") {
        // Defensive guard: stream=true was gated above; upstream should not
        // return SSE for a non-streaming request.
        reply.code(502).send({ error: "unexpected_stream" });
        return;
      }

      // Forward upstream status code.
      reply.code(result.status);

      // Forward relevant response headers; strip hop-by-hop headers.
      for (const [k, v] of Object.entries(result.headers)) {
        if (typeof v === "undefined") continue;
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        reply.header(k, v);
      }

      reply.send(result.body);
    } finally {
      // Release the slot. Non-fatal: the safety EXPIRE(300) on the ZSET key
      // will eventually evict the member even if this call fails.
      await releaseSlot(app.redis, "account", accountId, requestId).catch(
        () => {
          // Intentionally swallowed — slot expires on its own within SLOT_DURATION_MS.
        },
      );
    }
  });
}

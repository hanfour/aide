import Fastify, { type FastifyInstance } from "fastify";
import { parseServerEnv, type ServerEnv } from "@aide/config";
import type { Database } from "@aide/db";
import { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { metricsPlugin } from "./plugins/metrics.js";
import { dbPlugin } from "./plugins/db.js";
import { redisPlugin } from "./redis/client.js";
import { apiKeyAuthPlugin } from "./middleware/apiKeyAuth.js";
import { messagesRoutes } from "./routes/messages.js";
import { chatCompletionsRoutes } from "./routes/chatCompletions.js";
import {
  createUsageLogQueue,
  type UsageLogJobPayload,
} from "./workers/usageLogQueue.js";
import { UsageLogWorker } from "./workers/usageLogWorker.js";
import { BillingAudit } from "./workers/billingAudit.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * BullMQ usage-log queue. Decorated only when ENABLE_GATEWAY=true AND no
     * test-injected Redis was provided (BullMQ does not work with ioredis-mock,
     * so test paths skip queue/worker/audit instantiation entirely — see
     * `BuildOpts.redis` rationale in this file).
     *
     * Route handlers (Sub-task B/C) read this via `fastify.usageLogQueue` and
     * call `enqueueUsageLog(fastify.usageLogQueue, payload, { fallback: ... })`.
     */
    usageLogQueue?: Queue<UsageLogJobPayload>;
  }
}

export interface BuildOpts {
  env: ServerEnv;
  /** Optional test injection — passed straight through to dbPlugin. */
  db?: Database;
  /**
   * Optional test injection — passed straight through to redisPlugin.
   *
   * IMPORTANT: when `redis` is provided, we infer "this is a test" and skip
   * BullMQ queue/worker/audit instantiation entirely. Reason: BullMQ's Lua
   * scripts do not work against `ioredis-mock`, and existing tests inject
   * `ioredis-mock` via this seam. Production paths (where this option is
   * undefined) get the full BullMQ wiring against a fresh real Redis
   * connection built from `env.REDIS_URL`. Tests that need real BullMQ
   * lifecycle coverage live in `*.integration.test.ts` and stand up real
   * containers — they leave `redis` undefined.
   */
  redis?: Redis;
}

export async function buildServer(opts: BuildOpts): Promise<FastifyInstance> {
  const enabled = opts.env.ENABLE_GATEWAY;
  const app = Fastify({
    logger: { level: opts.env.LOG_LEVEL },
    bodyLimit: opts.env.GATEWAY_MAX_BODY_BYTES,
  });
  await app.register(metricsPlugin);
  app.get("/health", async () =>
    enabled ? { status: "ok" } : { status: "disabled" },
  );
  if (!enabled) {
    app.log.warn("ENABLE_GATEWAY=false, gateway serves /health only");
    return app;
  }
  await app.register(dbPlugin, { env: opts.env, db: opts.db });
  await app.register(redisPlugin, { env: opts.env, client: opts.redis });
  await app.register(apiKeyAuthPlugin, { env: opts.env });
  await app.register(messagesRoutes, { env: opts.env });
  await app.register(chatCompletionsRoutes, { env: opts.env });

  // BullMQ wiring: skip when a test injected its own Redis (see BuildOpts docs).
  if (opts.redis === undefined) {
    await wireUsageLogPipeline(app, opts.env);
  } else {
    app.log.info(
      "buildServer: opts.redis injected — skipping BullMQ queue/worker/audit (test mode)",
    );
  }

  return app;
}

/**
 * Build the dedicated BullMQ Redis connection + Queue + Worker + BillingAudit
 * and wire onClose teardown. Extracted so the test-injection escape hatch in
 * `buildServer` reads cleanly.
 *
 * Rationale for a separate Redis connection (vs reusing `fastify.redis`):
 * `redisPlugin` decorates `fastify.redis` with `keyPrefix: "aide:gw:"`. BullMQ
 * computes Redis keys inside Lua scripts using its own `prefix` option and
 * does not see ioredis's transparent key prefixing — passing the prefixed
 * client breaks Lua atomicity (see usageLogQueue.ts module header). We build
 * a fresh `Redis` from `env.REDIS_URL` with `maxRetriesPerRequest: null`
 * (BullMQ requirement for blocking commands) and `enableAutoPipelining: true`
 * (matches the gateway's prefixed client tuning).
 */
async function wireUsageLogPipeline(
  app: FastifyInstance,
  env: ServerEnv,
): Promise<void> {
  const redisUrl = env.REDIS_URL;
  if (!redisUrl) {
    // parseServerEnv enforces this when ENABLE_GATEWAY=true, but guard
    // defensively so a future env-shape change surfaces a clear error here.
    throw new Error(
      "REDIS_URL required to wire BullMQ usage-log pipeline (ENABLE_GATEWAY=true)",
    );
  }

  const bullmqRedis = new Redis(redisUrl, {
    enableAutoPipelining: true,
    // Required by BullMQ for blocking commands; see https://docs.bullmq.io/
    maxRetriesPerRequest: null,
  });

  bullmqRedis.on("error", (err: Error) => {
    app.log.warn({ err: err.message }, "bullmq redis error");
  });

  const queue = createUsageLogQueue({ connection: bullmqRedis });

  const worker = new UsageLogWorker(app.db, {
    logger: app.log,
    connection: bullmqRedis,
    queue,
    metrics: {
      queueDepth: app.gwMetrics.queueDepth,
      queueDlqCount: app.gwMetrics.queueDlqCount,
    },
  });
  worker.start();

  const audit = new BillingAudit(app.db, {
    logger: app.log,
    metrics: {
      billingDriftTotal: app.gwMetrics.billingDriftTotal,
      billingMonotonicityViolationTotal:
        app.gwMetrics.billingMonotonicityViolationTotal,
    },
  });
  audit.start();

  app.decorate("usageLogQueue", queue);

  // Teardown order matters:
  //   1. audit.stop()       — clear the timer so no new tick fires mid-shutdown
  //   2. worker.stop()      — drain in-flight batch + close BullMQ Worker
  //                            (waits for processor promises to settle)
  //   3. queue.close()      — close BullMQ Queue (releases its scheduler/etc.)
  //   4. bullmqRedis.quit() — close the dedicated ioredis connection last so
  //                            BullMQ's own close() above can still issue Redis
  //                            commands during shutdown
  app.addHook("onClose", async () => {
    audit.stop();
    try {
      await worker.stop();
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "usage log worker stop failed",
      );
    }
    try {
      await queue.close();
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "usage log queue close failed",
      );
    }
    await bullmqRedis.quit().catch((err: Error) => {
      app.log.debug(
        { err: err.message },
        "bullmq redis quit failed (likely already closed)",
      );
    });
  });
}

async function main() {
  const env = parseServerEnv(process.env);
  const app = await buildServer({ env });
  const port = env.GATEWAY_PORT;
  await app.listen({ port, host: "0.0.0.0" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

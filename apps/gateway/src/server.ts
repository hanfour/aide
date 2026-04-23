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
import {
  createBodyCaptureQueue,
  type BodyCaptureJobPayload,
} from "./workers/bodyCaptureQueue.js";
import {
  createEvaluatorQueue,
  type EvaluatorJobPayload,
} from "./workers/evaluator/queue.js";
import { UsageLogWorker } from "./workers/usageLogWorker.js";
import { BillingAudit } from "./workers/billingAudit.js";
import {
  startBodyPurgeCron,
  type BodyPurgeCronHandle,
} from "./workers/bodyPurge.js";
import {
  startEvaluatorCron,
  type EvaluatorCronHandle,
} from "./workers/evaluator/cron.js";

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
    /**
     * BullMQ body-capture queue. Decorated only when ENABLE_GATEWAY=true AND no
     * test-injected Redis was provided (same test-mode escape hatch as
     * `usageLogQueue`). Route handlers check for presence before enqueueing;
     * undefined means test mode — silently skip.
     */
    bodyCaptureQueue?: Queue<BodyCaptureJobPayload>;
    /**
     * BullMQ evaluator queue. Decorated only when ENABLE_GATEWAY=true AND no
     * test-injected Redis was provided (same test-mode escape hatch as other
     * queues). Cron handler subscribes to this queue to enqueue daily jobs.
     */
    evaluatorQueue?: Queue<EvaluatorJobPayload>;
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
    await wireBodyCapturePipeline(app, opts.env);
    await wireEvaluatorPipeline(app, opts.env);
  } else {
    app.log.debug(
      "buildServer: opts.redis injected — skipping BullMQ queue/worker/audit (test mode)",
    );
  }

  // Body retention purge cron — Plan 4B Task 3.6.
  // Runs every 4h, purges request_bodies where retention_until <= now().
  // Skip when a test injected its own Redis (same gate as BullMQ wiring above —
  // tests that need cron coverage call purgeExpiredBodies() directly).
  if (opts.redis === undefined) {
    let purgeCronHandle: BodyPurgeCronHandle | undefined;
    if (app.db) {
      purgeCronHandle = startBodyPurgeCron({
        db: app.db,
        metrics: {
          deletedTotal: app.gwMetrics.bodyPurgeDeletedTotal,
          durationSeconds: app.gwMetrics.bodyPurgeDurationSeconds,
          lagHours: app.gwMetrics.bodyPurgeLagHours,
        },
        logger: app.log,
      });
      app.addHook("onClose", async () => {
        purgeCronHandle?.stop();
      });
    }

    // Daily evaluator cron — Plan 4B Part 4, Task 4.3.
    // Runs every 24h at 00:05 UTC, enqueues daily evaluator jobs for all users
    // in orgs with contentCaptureEnabled=true.
    let evaluatorCronHandle: EvaluatorCronHandle | undefined;
    if (app.db && app.evaluatorQueue) {
      evaluatorCronHandle = startEvaluatorCron({
        db: app.db,
        queue: app.evaluatorQueue,
        logger: app.log,
      });
      app.addHook("onClose", async () => {
        evaluatorCronHandle?.stop();
      });
    }
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
  //
  // The try/catch wrappers below catch thrown errors only — a step that hangs
  // (e.g. worker.stop() blocked on a wedged batch) will still stall shutdown
  // because its `await` never settles. For hard-deadline shutdown we'd need
  // Promise.race with a timeout; not added here because Fastify's close() has
  // a server-level grace and a hung BullMQ Worker indicates a deeper bug.
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
    // Required: BullMQ treats the passed-in ioredis instance as shared and
    // skips quit() inside Worker.close() / Queue.close(). Without this line
    // the TCP connection leaks until process exit.
    await bullmqRedis.quit().catch((err: Error) => {
      app.log.debug(
        { err: err.message },
        "bullmq redis quit failed (likely already closed)",
      );
    });
  });
}

/**
 * Build the dedicated BullMQ Redis connection + Queue for body capture and
 * wire onClose teardown. The worker is managed externally (bodyCaptureWorker.ts)
 * and not started here — only the queue is decorated so route handlers can enqueue.
 *
 * Uses a separate Redis connection from usageLogPipeline (same rationale: BullMQ
 * Lua scripts cannot share the prefixed `fastify.redis` client).
 */
async function wireBodyCapturePipeline(
  app: FastifyInstance,
  env: ServerEnv,
): Promise<void> {
  const redisUrl = env.REDIS_URL;
  if (!redisUrl) {
    throw new Error(
      "REDIS_URL required to wire BullMQ body-capture pipeline (ENABLE_GATEWAY=true)",
    );
  }

  const bullmqRedis = new Redis(redisUrl, {
    enableAutoPipelining: true,
    maxRetriesPerRequest: null,
  });

  bullmqRedis.on("error", (err: Error) => {
    app.log.warn({ err: err.message }, "body capture bullmq redis error");
  });

  const queue = createBodyCaptureQueue({ connection: bullmqRedis });

  app.decorate("bodyCaptureQueue", queue);

  app.addHook("onClose", async () => {
    try {
      await queue.close();
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "body capture queue close failed",
      );
    }
    await bullmqRedis.quit().catch((err: Error) => {
      app.log.debug(
        { err: err.message },
        "body capture bullmq redis quit failed (likely already closed)",
      );
    });
  });
}

/**
 * Build the dedicated BullMQ Redis connection + Queue for evaluator cron
 * and wire onClose teardown. The cron is started in buildServer and manages
 * itself via the EvaluatorCronHandle; only the queue is decorated here so the
 * cron can enqueue jobs.
 *
 * Uses a separate Redis connection from other pipelines (same rationale: BullMQ
 * Lua scripts cannot share the prefixed `fastify.redis` client).
 */
async function wireEvaluatorPipeline(
  app: FastifyInstance,
  env: ServerEnv,
): Promise<void> {
  const redisUrl = env.REDIS_URL;
  if (!redisUrl) {
    throw new Error(
      "REDIS_URL required to wire BullMQ evaluator pipeline (ENABLE_GATEWAY=true)",
    );
  }

  const bullmqRedis = new Redis(redisUrl, {
    enableAutoPipelining: true,
    maxRetriesPerRequest: null,
  });

  bullmqRedis.on("error", (err: Error) => {
    app.log.warn({ err: err.message }, "evaluator bullmq redis error");
  });

  const queue = createEvaluatorQueue({ connection: bullmqRedis });

  app.decorate("evaluatorQueue", queue);

  app.addHook("onClose", async () => {
    try {
      await queue.close();
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "evaluator queue close failed",
      );
    }
    await bullmqRedis.quit().catch((err: Error) => {
      app.log.debug(
        { err: err.message },
        "evaluator bullmq redis quit failed (likely already closed)",
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

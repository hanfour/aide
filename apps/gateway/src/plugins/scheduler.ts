// Decorates the Fastify instance with a singleton `AccountScheduler`
// (Plan 5A Part 7, addressing PR #38 review H2). Without this, every
// request would build a fresh scheduler — meaning EWMA stats never
// accumulate and the load-balance scoring degrades to "everyone is
// cold". One scheduler per process keeps the rolling reliability +
// TTFT signal alive across requests.
//
// Ordering: must register AFTER `metricsPlugin`, `dbPlugin`, and
// `redisPlugin` so it can wire all three into the scheduler.

import fp from "fastify-plugin";
import {
  createScheduler,
  type AccountScheduler,
} from "../runtime/scheduler.js";
import { createSchedulerMetricsAdapter } from "../runtime/schedulerMetricsAdapter.js";

declare module "fastify" {
  interface FastifyInstance {
    gwScheduler: AccountScheduler;
  }
}

export const schedulerPlugin = fp(
  async (fastify) => {
    const scheduler = createScheduler({
      db: fastify.db,
      redis: fastify.redis,
      metrics: createSchedulerMetricsAdapter(fastify.gwMetrics),
      onStickyError: (err, layer) => {
        fastify.log.warn(
          { err: err instanceof Error ? err.message : String(err), layer },
          "scheduler sticky read failed — falling through to Layer 3",
        );
      },
    });
    fastify.decorate("gwScheduler", scheduler);
  },
  {
    name: "schedulerPlugin",
    // Reads `fastify.db`, `fastify.redis`, and `fastify.gwMetrics`.
    dependencies: ["dbPlugin", "redisPlugin", "metricsPlugin"],
  },
);

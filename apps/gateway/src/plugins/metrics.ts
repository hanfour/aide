import fp from "fastify-plugin";
import * as fm from "fastify-metrics";
import type { IMetricsPluginOptions } from "fastify-metrics";
import { Counter, Histogram, Gauge, type Registry } from "prom-client";
// fastify-metrics ships CJS; interop helper ensures we get the plugin function regardless of bundler resolution
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fastifyMetrics = ((fm as any).default ?? fm) as (fm: any) => any;

export interface GatewayMetrics {
  slotAcquireTotal: Counter<"scope" | "result">;
  slotHoldDurationSeconds: Histogram<string>;
  waitQueueDepth: Gauge<string>;
  idempotencyHitTotal: Counter<string>;
  stickyHitTotal: Counter<string>;
  redisLatencySeconds: Histogram<string>;
  upstreamDurationSeconds: Histogram<string>;
  pricingMissTotal: Counter<"model">;
  oauthRefreshDeadTotal: Counter<"account_id">;
  queueDepth: Gauge<string>;
  queueDlqCount: Gauge<string>;
  usagePersistLostTotal: Counter<string>;
}

declare module "fastify" {
  interface FastifyInstance {
    gwMetrics: GatewayMetrics;
  }
}

export const metricsPlugin = fp(async (fastify) => {
  await fastify.register(fastifyMetrics, {
    endpoint: "/metrics",
    // Owns the prom-client default singleton; no other process module should register against it.
    clearRegisterOnInit: true,
    routeMetrics: { enabled: true },
    defaultMetrics: { enabled: true },
  });

  // fastify.metrics.client is the prom-client module; .register is the global registry
  const register = fastify.metrics.client.register as Registry;

  const slotAcquireTotal = new Counter({
    name: "gw_slot_acquire_total",
    help: "Slot acquisition attempts",
    labelNames: ["scope", "result"] as const,
    registers: [register],
  });

  // TODO(part-5): tune buckets for upstream durations >10s; defaults are HTTP-shaped
  const slotHoldDurationSeconds = new Histogram({
    name: "gw_slot_hold_duration_seconds",
    help: "Time a slot was held",
    registers: [register],
  });

  const waitQueueDepth = new Gauge({
    name: "gw_wait_queue_depth",
    help: "Current wait-queue depth",
    registers: [register],
  });

  const idempotencyHitTotal = new Counter({
    name: "gw_idempotency_hit_total",
    help: "Idempotency cache hits",
    registers: [register],
  });

  const stickyHitTotal = new Counter({
    name: "gw_sticky_hit_total",
    help: "Sticky-session cache hits",
    registers: [register],
  });

  const redisLatencySeconds = new Histogram({
    name: "gw_redis_latency_seconds",
    help: "Redis call latency",
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
  });

  // TODO(part-5): tune buckets for upstream durations >10s; defaults are HTTP-shaped
  const upstreamDurationSeconds = new Histogram({
    name: "gw_upstream_duration_seconds",
    help: "Upstream API call duration",
    registers: [register],
  });

  const pricingMissTotal = new Counter({
    name: "gw_pricing_miss_total",
    help: "Pricing lookup misses",
    labelNames: ["model"] as const,
    registers: [register],
  });

  const oauthRefreshDeadTotal = new Counter({
    name: "gw_oauth_refresh_dead_total",
    help: "OAuth refresh failures past max",
    labelNames: ["account_id"] as const,
    registers: [register],
  });

  const queueDepth = new Gauge({
    name: "gw_queue_depth",
    help: "BullMQ wait+active count",
    registers: [register],
  });

  const queueDlqCount = new Gauge({
    name: "gw_queue_dlq_count",
    help: "BullMQ failed (DLQ) count",
    registers: [register],
  });

  // Rare event: BOTH the BullMQ enqueue AND the inline DB fallback failed,
  // so the usage_logs row was dropped.  Surfaces in dashboards as a
  // monotonic counter; any non-zero rate should page (Plan 4A Part 7
  // Section 5.1).
  const usagePersistLostTotal = new Counter({
    name: "gw_usage_persist_lost_total",
    help: "Usage log rows dropped after BullMQ + inline DB write both failed",
    registers: [register],
  });

  // Materialize zero values so unlabeled metrics appear in scrape output
  waitQueueDepth.set(0);
  idempotencyHitTotal.inc(0);
  stickyHitTotal.inc(0);
  queueDepth.set(0);
  queueDlqCount.set(0);
  usagePersistLostTotal.inc(0);
  // Histograms appear as _count/_sum=0 without an explicit observation

  fastify.decorate("gwMetrics", {
    slotAcquireTotal,
    slotHoldDurationSeconds,
    waitQueueDepth,
    idempotencyHitTotal,
    stickyHitTotal,
    redisLatencySeconds,
    upstreamDurationSeconds,
    pricingMissTotal,
    oauthRefreshDeadTotal,
    queueDepth,
    queueDlqCount,
    usagePersistLostTotal,
  });
});

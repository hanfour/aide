// Adapts the Prometheus metrics registered in `plugins/metrics.ts` to the
// scheduler's `SchedulerMetrics` interface (Plan 5A Part 7, Task 7.7). Kept
// out of the scheduler module so the scheduler stays free of any Fastify /
// prom-client coupling and remains trivially unit-testable.
//
// The sticky-hit ratio is maintained as an EWMA so it survives across
// scrapes without the scheduler having to remember a window: a hit
// pushes the gauge toward 1, a miss pushes it toward 0. The "forced"
// layer is excluded — it isn't a real sticky decision and would skew
// the ratio in dashboards.

import type { GatewayMetrics } from "../plugins/metrics.js";
import type { ScheduleDecision, SchedulerMetrics } from "./scheduler.js";

const STICKY_RATIO_ALPHA = 0.1;

interface PlatformState {
  ratio: number;
  initialized: boolean;
}

export function createSchedulerMetricsAdapter(
  metrics: GatewayMetrics,
): SchedulerMetrics {
  const stickyRatioByPlatform = new Map<string, PlatformState>();

  return {
    recordSelect(decision: ScheduleDecision): void {
      const { platform, layer } = decision;
      metrics.gwSchedulerSelectTotal.inc({ platform, layer });

      // Don't fold the "forced" path into the sticky-hit ratio — it's a
      // bypass, not a sticky outcome.
      if (layer === "forced") return;

      const observation = decision.stickyHit ? 1 : 0;
      const prev =
        stickyRatioByPlatform.get(platform) ??
        ({ ratio: 0, initialized: false } as PlatformState);
      const nextRatio = prev.initialized
        ? STICKY_RATIO_ALPHA * observation +
          (1 - STICKY_RATIO_ALPHA) * prev.ratio
        : observation;
      stickyRatioByPlatform.set(platform, {
        ratio: nextRatio,
        initialized: true,
      });
      metrics.gwSchedulerStickyHitRatio.set({ platform }, nextRatio);
    },

    recordSwitch(platform: string): void {
      metrics.gwSchedulerAccountSwitchTotal.inc({ platform });
    },

    recordLatency(platform: string, ms: number): void {
      metrics.gwSchedulerLatencyMs.observe({ platform }, ms);
    },

    recordLoadSkew(platform: string, skew: number): void {
      // Negative skew is meaningless; clamp at 0 for the gauge.
      metrics.gwSchedulerLoadSkew.set({ platform }, Math.max(0, skew));
    },

    recordRuntimeAccountCount(count: number): void {
      metrics.gwSchedulerRuntimeAccountCount.set(count);
    },
  };
}

// Adapts the Prometheus metrics registered in `plugins/metrics.ts` to the
// scheduler's `SchedulerMetrics` interface (Plan 5A Part 7, Task 7.7). Kept
// out of the scheduler module so the scheduler stays free of any Fastify /
// prom-client coupling and remains trivially unit-testable.
//
// The sticky-hit ratio is maintained as an EWMA so it survives across
// scrapes without the scheduler having to remember a window: a hit
// pushes the gauge toward 1, a miss pushes it toward 0.

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
      const platform = decision.selectedAccountType /* fallback label slot */;
      // Layer + platform should both be observable; `platform` here uses the
      // account's platform unless the caller passes `groupPlatform`. Layer
      // values match `ScheduleLayer` so dashboards can pivot freely.
      metrics.gwSchedulerSelectTotal.inc({
        platform,
        layer: decision.layer,
      });

      const observation = decision.stickyHit ? 1 : 0;
      const prev =
        stickyRatioByPlatform.get(platform) ??
        ({ ratio: 0, initialized: false } as PlatformState);
      const nextRatio = prev.initialized
        ? STICKY_RATIO_ALPHA * observation + (1 - STICKY_RATIO_ALPHA) * prev.ratio
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

    recordRuntimeAccountCount(platform: string, count: number): void {
      metrics.gwSchedulerRuntimeAccountCount.set({ platform }, count);
    },
  };
}

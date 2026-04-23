/**
 * BullMQ evaluator worker factory (Plan 4B Part 4, Task 4.2).
 *
 * Consumes `evaluator` queue jobs. Each job fetches usage data for the given
 * user/period, scores it via the rule engine, and upserts an evaluation_report.
 *
 * Concurrency is kept at 2 (not 4 like body capture) because evaluator jobs
 * are CPU and DB heavy — fetch + decrypt + aggregate.
 */

import { Worker, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Database } from "@aide/db";
import {
  EVALUATOR_QUEUE_NAME,
  EVALUATOR_QUEUE_PREFIX,
  EvaluatorJobPayload,
} from "./queue.js";
import { runRuleBased } from "./runRuleBased.js";
import { createRubricResolver } from "./rubricResolver.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CreateEvaluatorWorkerOptions {
  connection: Redis;
  db: Database;
  masterKeyHex: string;
  concurrency?: number;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a BullMQ Worker wired to the `aide:gw:evaluator` queue.
 *
 * The worker validates the job payload via Zod, resolves the appropriate rubric
 * for the org (custom or platform-default), then delegates to `runRuleBased`.
 *
 * The rubric resolver is created once at the factory level so cache persists
 * across jobs.
 */
export function createEvaluatorWorker(
  opts: CreateEvaluatorWorkerOptions,
): Worker<EvaluatorJobPayload, void> {
  // Create resolver ONCE at factory level so cache persists across jobs
  const resolver = createRubricResolver();

  return new Worker<EvaluatorJobPayload, void>(
    EVALUATOR_QUEUE_NAME,
    async (job) => {
      const payload = EvaluatorJobPayload.parse(job.data);

      // Resolve rubric: org custom → platform-default by locale
      const resolved = await resolver.resolve({
        db: opts.db,
        orgId: payload.orgId,
      });

      await runRuleBased({
        db: opts.db,
        masterKeyHex: opts.masterKeyHex,
        orgId: payload.orgId,
        userId: payload.userId,
        periodStart: new Date(payload.periodStart),
        periodEnd: new Date(payload.periodEnd),
        periodType: payload.periodType,
        rubric: resolved.rubric,
        rubricId: resolved.rubricId,
        rubricVersion: resolved.rubricVersion,
        triggeredBy: payload.triggeredBy,
        triggeredByUser: payload.triggeredByUser,
      });
    },
    {
      connection: opts.connection,
      prefix: EVALUATOR_QUEUE_PREFIX,
      concurrency: opts.concurrency ?? 2,
    } satisfies WorkerOptions,
  );
}

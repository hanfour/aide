/**
 * Usage log batched worker (Plan 4A Part 7, Task 7.2).
 *
 * Drains the BullMQ `aide:gw:usage-log` queue in batches of up to 100 jobs OR
 * a 1000ms flush interval, whichever comes first. Each batch:
 *   1. Opens a Drizzle transaction.
 *   2. Performs a single multi-row INSERT into `usage_logs`.
 *   3. Issues ONE UPDATE per distinct `api_key_id`, summing the batch's
 *      `total_cost` for that key and bumping `last_used_at`.
 *   4. Commits.
 *
 * The cost decimals are summed in JS as plain string concatenation into a SQL
 * `+ <decimal>::numeric` expression on the UPDATE — Postgres handles the
 * arithmetic so we never lose precision to JS floats. (See note in flush().)
 *
 * On txn failure: every per-job promise is rejected with the txn error. The
 * processor function re-throws, BullMQ schedules a retry per its exponential
 * backoff, and after `attempts=3` failures the job lands in the failed set
 * (DLQ). The worker keeps the `gw_queue_dlq_count` gauge in sync after each
 * flush so dashboards reflect the failed-set size in near real time.
 *
 * Why a batcher (vs polling Queue.getJobs):
 *   BullMQ's Worker model is per-job. To batch we set `concurrency = batchSize`
 *   and let the Worker invoke our processor up to N times in parallel. Each
 *   processor call appends its payload to a shared batcher and awaits the
 *   batcher's flush promise. When the batcher reaches its size or time limit,
 *   it runs ONE txn for all collected payloads and resolves each call's
 *   promise. This is the dataloader-style coalescing pattern, kept inline so
 *   we don't pull in the dependency.
 */

import { eq, sql } from "drizzle-orm";
import { Worker, type Job, type RedisOptions } from "bullmq";
import type { Redis } from "ioredis";
import { apiKeys, usageLogs } from "@aide/db";
import type { Database } from "@aide/db";
import {
  USAGE_LOG_QUEUE_NAME,
  USAGE_LOG_QUEUE_PREFIX,
  type UsageLogJobPayload,
} from "./usageLogQueue.js";

// ── Defaults ─────────────────────────────────────────────────────────────────

/** Max payloads per transaction (matches Worker concurrency). */
const DEFAULT_BATCH_SIZE = 100;

/** Force-flush even if the batch hasn't filled yet, in milliseconds. */
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Pino-style logger surface used by the worker.  Mirrors the shape used by
 * `OAuthRefreshCron` so we can pass `fastify.log` directly.
 */
export interface UsageLogWorkerLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

/**
 * Subset of `prom-client.Gauge` we touch.  Concrete gauges live in
 * `plugins/metrics.ts`; tests can pass any object that satisfies this shape.
 */
export interface GaugeLike {
  set(value: number): void;
}

export interface UsageLogWorkerMetrics {
  /** Current wait+active job count. */
  queueDepth?: GaugeLike;
  /** Current failed (DLQ) job count. */
  queueDlqCount?: GaugeLike;
}

/**
 * Subset of BullMQ's Queue API the worker queries for metric updates.  Exposed
 * so tests can inject a stub instead of standing up a real queue.
 */
export interface QueueCounters {
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
}

export type UsageLogWorkerConnection = Redis | RedisOptions;

export interface UsageLogWorkerOptions {
  logger: UsageLogWorkerLogger;
  /** BullMQ connection (ioredis instance or RedisOptions). */
  connection: UsageLogWorkerConnection;
  /** Queue handle used to read job counts after each flush. */
  queue: QueueCounters;
  /** Override module default. */
  batchSize?: number;
  /** Override module default. */
  flushIntervalMs?: number;
  /** Optional metric gauges to keep in sync. */
  metrics?: UsageLogWorkerMetrics;
  /** Override prefix (matches the queue's prefix). Defaults to `aide:gw`. */
  prefix?: string;
}

// ── Internal: Batcher ────────────────────────────────────────────────────────

/**
 * One in-flight batch.  Built lazily when the first payload arrives and
 * sealed once it reaches `batchSize` or its flush timer fires.  Each entry
 * carries the payload plus the resolve/reject hooks for the per-job promise
 * the processor is awaiting.
 */
interface BatchEntry {
  payload: UsageLogJobPayload;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface PendingBatch {
  entries: BatchEntry[];
  /** Timer that force-flushes when no further payloads arrive. */
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * True once flush() has started consuming this batch.  Subsequent add()
   * calls must build a NEW batch — appending to one mid-flush would break the
   * txn's atomicity guarantee.
   */
  sealed: boolean;
}

// ── Worker ───────────────────────────────────────────────────────────────────

export class UsageLogWorker {
  readonly #db: Database;
  readonly #opts: UsageLogWorkerOptions;
  readonly #batchSize: number;
  readonly #flushIntervalMs: number;

  /** The current open batch, or null if no payloads are in flight. */
  #pending: PendingBatch | null = null;

  /** BullMQ Worker handle. Null until start(). */
  #worker: Worker<UsageLogJobPayload> | null = null;

  constructor(db: Database, opts: UsageLogWorkerOptions) {
    this.#db = db;
    this.#opts = opts;
    this.#batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  /**
   * Construct + start the BullMQ Worker.  Idempotent — calling start() twice
   * is a no-op.  The Worker autoruns by default; we leave that on so jobs
   * begin processing immediately.
   */
  start(): void {
    if (this.#worker !== null) return;
    this.#worker = new Worker<UsageLogJobPayload>(
      USAGE_LOG_QUEUE_NAME,
      (job) => this.#process(job),
      {
        connection: this.#opts.connection,
        prefix: this.#opts.prefix ?? USAGE_LOG_QUEUE_PREFIX,
        concurrency: this.#batchSize,
      },
    );

    // Surface BullMQ-side errors through the injected logger; without this
    // listener BullMQ logs to console and emits 'error' events that crash on
    // unhandled emit.
    this.#worker.on("error", (err) => {
      this.#opts.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "usage log worker: bullmq error",
      );
    });
  }

  /**
   * Gracefully stop the worker.  Forces a flush of any in-flight batch first
   * so jobs already accepted by the processor don't get retried as stalled,
   * then closes the BullMQ Worker.  Finally, runs one last metrics refresh so
   * the gauges reflect the post-shutdown queue state (BullMQ finalises the
   * failed-set entry only after the processor's promise rejects, so an
   * in-flush refresh races BullMQ's bookkeeping).
   *
   * Idempotent.
   */
  async stop(): Promise<void> {
    if (this.#pending !== null) {
      await this.#flush();
    }
    if (this.#worker !== null) {
      const w = this.#worker;
      this.#worker = null;
      await w.close();
    }
    await this.refreshMetrics().catch((err) => {
      this.#opts.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "usage log worker: final metrics refresh failed",
      );
    });
  }

  /**
   * Pull current job counts from BullMQ and propagate to the gauges.
   * Public so callers (and tests) can force a refresh without waiting for
   * the next batch flush.  Best-effort: errors bubble out; the worker's
   * internal post-flush call wraps it in a try/catch.
   */
  async refreshMetrics(): Promise<void> {
    if (this.#opts.metrics === undefined) return;
    const counts = await this.#opts.queue.getJobCounts(
      "waiting",
      "active",
      "failed",
    );
    const waiting = counts.waiting ?? 0;
    const active = counts.active ?? 0;
    const failed = counts.failed ?? 0;
    this.#opts.metrics.queueDepth?.set(waiting + active);
    this.#opts.metrics.queueDlqCount?.set(failed);
  }

  // ── Processor ──────────────────────────────────────────────────────────────

  /**
   * BullMQ processor function.  Adds the job's payload to the batcher and
   * awaits the batch's flush.  On flush success, returns silently and BullMQ
   * marks the job completed.  On flush failure, throws — BullMQ schedules a
   * retry per the queue's `attempts` policy.
   */
  async #process(job: Job<UsageLogJobPayload>): Promise<void> {
    await this.#addToBatch(job.data);
  }

  /**
   * Append a payload to the current batch (or start a new one).  Returns a
   * promise that resolves/rejects with the txn outcome for that batch.
   */
  #addToBatch(payload: UsageLogJobPayload): Promise<void> {
    const batch = this.#ensureOpenBatch();

    return new Promise<void>((resolve, reject) => {
      batch.entries.push({ payload, resolve, reject });

      if (batch.entries.length >= this.#batchSize && !batch.sealed) {
        // Size trigger — flush immediately. Cancel the timer; flush() will
        // null out #pending so the next add() opens a fresh batch.
        if (batch.timer !== null) {
          clearTimeout(batch.timer);
          batch.timer = null;
        }
        // Fire-and-forget: per-call promises (resolve/reject) are still tied
        // to flush completion via the entry's resolve/reject hooks.
        void this.#flush();
      }
    });
  }

  /**
   * Return the open batch, lazily creating one (and arming its flush timer)
   * if no batch is currently accepting entries.
   */
  #ensureOpenBatch(): PendingBatch {
    if (this.#pending !== null && !this.#pending.sealed) {
      return this.#pending;
    }

    const batch: PendingBatch = {
      entries: [],
      timer: null,
      sealed: false,
    };

    batch.timer = setTimeout(() => {
      // Time trigger — only flush if this batch is still the open one and
      // hasn't already been size-flushed.
      if (this.#pending === batch && !batch.sealed) {
        void this.#flush();
      }
    }, this.#flushIntervalMs);

    // Don't keep the event loop alive solely for this timer — important for
    // tests that import the worker and exit cleanly.
    if (typeof batch.timer.unref === "function") {
      batch.timer.unref();
    }

    this.#pending = batch;
    return batch;
  }

  /**
   * Drain the current batch into a single Drizzle transaction.  Resolves all
   * per-entry promises on commit; rejects them all with the txn error on
   * failure.  After completion, refreshes the queueDepth + queueDlqCount
   * metrics from BullMQ.
   *
   * Concurrency guard: this is fire-and-forget from add(), so two callers
   * (size trigger + time trigger) could both schedule a flush. The `sealed`
   * flag prevents double-execution — the first flush() seals the batch and
   * clears `#pending`; the second sees `sealed === true` and bails.
   */
  async #flush(): Promise<void> {
    const batch = this.#pending;
    if (batch === null || batch.sealed) return;

    batch.sealed = true;
    if (batch.timer !== null) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
    // Open the next batch slot before we await anything async.
    this.#pending = null;

    const entries = batch.entries;
    if (entries.length === 0) return;

    try {
      await this.#runTxn(entries.map((e) => e.payload));
      for (const entry of entries) entry.resolve();
      this.#opts.logger.info(
        { count: entries.length },
        "usage log worker: batch committed",
      );
    } catch (err) {
      this.#opts.logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          count: entries.length,
        },
        "usage log worker: batch txn failed",
      );
      for (const entry of entries) entry.reject(err);
    } finally {
      await this.refreshMetrics().catch((err) => {
        this.#opts.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "usage log worker: metrics refresh failed",
        );
      });
    }
  }

  /**
   * Single-transaction batch write.
   *
   * Insert step: one multi-row INSERT INTO usage_logs.  We map every payload
   * field 1:1 to its column.
   *
   * Update step: group payloads by api_key_id, sum totalCost as a string
   * (concatenated into a SQL fragment), and issue ONE UPDATE per group:
   *
   *   UPDATE api_keys
   *      SET quota_used_usd = quota_used_usd + <sum>::numeric,
   *          last_used_at   = NOW(),
   *          updated_at     = NOW()
   *    WHERE id = <api_key_id>
   *
   * Sum-as-string rationale: cost decimals can be up to 10 fractional digits.
   * Summing in JS via Number() loses precision past ~15 significant digits.
   * Building `(c1 + c2 + ... + cN)::numeric` lets Postgres do exact-decimal
   * arithmetic.  We pass each value as a parameterised `sql.placeholder`
   * equivalent (`${value}`) so injection is impossible.
   */
  async #runTxn(payloads: UsageLogJobPayload[]): Promise<void> {
    await this.#db.transaction(async (tx) => {
      // 1. Multi-row INSERT into usage_logs.
      await tx.insert(usageLogs).values(
        payloads.map((p) => ({
          requestId: p.requestId,
          userId: p.userId,
          apiKeyId: p.apiKeyId,
          accountId: p.accountId,
          orgId: p.orgId,
          teamId: p.teamId,
          requestedModel: p.requestedModel,
          upstreamModel: p.upstreamModel,
          platform: p.platform,
          surface: p.surface,
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens,
          cacheCreationTokens: p.cacheCreationTokens,
          cacheReadTokens: p.cacheReadTokens,
          inputCost: p.inputCost,
          outputCost: p.outputCost,
          cacheCreationCost: p.cacheCreationCost,
          cacheReadCost: p.cacheReadCost,
          totalCost: p.totalCost,
          rateMultiplier: p.rateMultiplier,
          accountRateMultiplier: p.accountRateMultiplier,
          stream: p.stream,
          statusCode: p.statusCode,
          durationMs: p.durationMs,
          firstTokenMs: p.firstTokenMs,
          bufferReleasedAtMs: p.bufferReleasedAtMs,
          upstreamRetries: p.upstreamRetries,
          failedAccountIds: p.failedAccountIds,
          userAgent: p.userAgent,
          ipAddress: p.ipAddress,
        })),
      );

      // 2. One UPDATE per distinct api_key_id with the SUMmed totalCost.
      const grouped = groupTotalCostByApiKey(payloads);
      for (const [apiKeyId, totals] of grouped.entries()) {
        const sumExpr = buildNumericSumExpr(totals);
        await tx
          .update(apiKeys)
          .set({
            quotaUsedUsd: sql`${apiKeys.quotaUsedUsd} + ${sumExpr}`,
            lastUsedAt: sql`NOW()`,
            updatedAt: sql`NOW()`,
          })
          .where(eq(apiKeys.id, apiKeyId));
      }
    });
  }
}

// ── Internal helpers (exported for unit testing) ─────────────────────────────

/**
 * Group payloads by `apiKeyId`, returning a Map of api_key_id → list of
 * `totalCost` strings to add.  Map iteration order is insertion order, so
 * the resulting UPDATEs are deterministic per batch.
 */
export function groupTotalCostByApiKey(
  payloads: UsageLogJobPayload[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of payloads) {
    const list = out.get(p.apiKeyId);
    if (list === undefined) {
      out.set(p.apiKeyId, [p.totalCost]);
    } else {
      list.push(p.totalCost);
    }
  }
  return out;
}

/**
 * Build an `sql` fragment of the form `(v1 + v2 + ... + vN)::numeric` where
 * each vᵢ is parameterised. Decimal sums computed in Postgres preserve full
 * `decimal(20,8)` precision; doing the sum in JS via Number addition loses
 * precision past ~15 significant digits.
 *
 * Single-element batches collapse to `(v1)::numeric`, which Postgres folds.
 */
export function buildNumericSumExpr(values: string[]) {
  if (values.length === 0) {
    // Defensive — shouldn't happen because groupTotalCostByApiKey only
    // produces non-empty arrays — but a 0::numeric add is a safe no-op.
    return sql`0::numeric`;
  }
  // Build the expression incrementally so each value is its own parameter.
  // sql.join would let us interpose ' + ' but using reduce keeps the
  // parameters explicit and easy to audit.
  let acc = sql`${values[0]}::numeric`;
  for (let i = 1; i < values.length; i++) {
    acc = sql`${acc} + ${values[i]}::numeric`;
  }
  return sql`(${acc})`;
}

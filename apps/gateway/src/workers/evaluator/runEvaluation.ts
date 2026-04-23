/**
 * Evaluation orchestrator (Plan 4B Part 5, Task 5.3).
 *
 * Combines rule-based scoring (Task 4.2) with optional LLM deep analysis
 * (Task 5.2) into a single entry point. The worker calls this function
 * instead of `runRuleBased` directly.
 *
 * Flow:
 *   1. Run rule-based → get Report + bodies (no DB write).
 *   2. If org has llmEvalEnabled=true AND coverageRatio >= 0.5 → run LLM.
 *   3. Upsert report into evaluation_reports (with or without LLM columns).
 *   4. If LLM fails → proceed with rule-based only; LLM columns stay NULL.
 */

import type { Database } from "@aide/db";
import type { Redis } from "ioredis";
import type { Rubric } from "@aide/evaluator";
import {
  runRuleBased,
  upsertEvaluationReport,
  type UpsertEvaluationReportInput,
} from "./runRuleBased.js";
import { runLlmDeepAnalysis } from "./runLlm.js";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimum body coverage ratio required to run LLM deep analysis.
 * Below this threshold the LLM cannot meaningfully cite evidence.
 * (Design spec §4.2)
 */
export const LLM_MIN_COVERAGE_RATIO = 0.5;

// ── Input / Output types ─────────────────────────────────────────────────────

export interface RunEvaluationInput {
  db: Database;
  redis: Redis;
  masterKeyHex: string;
  gatewayBaseUrl: string;
  orgId: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
  periodType: "daily" | "weekly" | "monthly";
  rubric: Rubric;
  rubricId: string;
  rubricVersion: string;
  triggeredBy: "cron" | "admin_rerun" | "manual";
  triggeredByUser: string | null;
  /** Read from org row by caller; passed in explicitly to avoid a redundant DB round-trip. */
  llmEvalEnabled: boolean;
  /** For test injection — overrides global fetch. */
  fetchImpl?: typeof fetch;
  /** For test injection — overrides sleep delays in LLM cost lookup. */
  sleepMs?: (ms: number) => Promise<void>;
}

export interface RunEvaluationResult {
  reportId: string | null;
  totalScore: number;
  skipped: boolean;
  llmAttempted: boolean;
  llmSucceeded: boolean;
  llmCostUsd: number;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function runEvaluation(
  input: RunEvaluationInput,
): Promise<RunEvaluationResult> {
  // Phase 1: rule-based scoring (no DB write)
  const rb = await runRuleBased({
    db: input.db,
    masterKeyHex: input.masterKeyHex,
    orgId: input.orgId,
    userId: input.userId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    rubric: input.rubric,
  });

  if (rb.skipped) {
    return {
      reportId: null,
      totalScore: 0,
      skipped: true,
      llmAttempted: false,
      llmSucceeded: false,
      llmCostUsd: 0,
    };
  }

  // Phase 2: optional LLM deep analysis
  // Gate: org opted in AND we have enough body coverage to cite evidence.
  const shouldRunLlm =
    input.llmEvalEnabled &&
    rb.report.dataQuality.coverageRatio >= LLM_MIN_COVERAGE_RATIO;

  let llmResult: Awaited<ReturnType<typeof runLlmDeepAnalysis>> = null;

  if (shouldRunLlm) {
    llmResult = await runLlmDeepAnalysis({
      db: input.db,
      redis: input.redis,
      gatewayBaseUrl: input.gatewayBaseUrl,
      orgId: input.orgId,
      rubric: input.rubric,
      ruleBasedReport: rb.report,
      bodies: rb.bodies,
      fetchImpl: input.fetchImpl,
      sleepMs: input.sleepMs,
    });
  }

  // Phase 3: upsert — always runs (even when LLM failed; llm columns stay NULL)
  const upsertInput: UpsertEvaluationReportInput = {
    db: input.db,
    orgId: input.orgId,
    userId: input.userId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    periodType: input.periodType,
    rubricId: input.rubricId,
    rubricVersion: input.rubricVersion,
    triggeredBy: input.triggeredBy,
    triggeredByUser: input.triggeredByUser,
    report: rb.report,
    llm: llmResult
      ? {
          narrative: llmResult.narrative,
          evidence: llmResult.evidence,
          model: llmResult.model,
          calledAt: new Date(),
          costUsd: llmResult.costUsd,
          upstreamAccountId: llmResult.upstreamAccountId,
        }
      : null,
  };

  const reportId = await upsertEvaluationReport(upsertInput);

  return {
    reportId,
    totalScore: rb.report.totalScore,
    skipped: false,
    llmAttempted: shouldRunLlm,
    llmSucceeded: llmResult !== null,
    llmCostUsd: llmResult?.costUsd ?? 0,
  };
}

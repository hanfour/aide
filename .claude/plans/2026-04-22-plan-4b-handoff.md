# Plan 4B Handoff — 2026-04-22

Session paused intentionally after design spec + implementation plan written. Resume here.

## Repo state

- Working dir: `/Users/hanfourhuang/ai-dev-eval`
- Main branch: `main` at `a8ec56a` (Plan 4A v0.3.0 merged; Plan 4B spec + plan committed, no implementation)
- Current branch: `main`
- No WIP; clean tree
- Latest tag: `v0.3.0`

## Plan 4B artifacts

- **Design spec**: `.claude/plans/2026-04-22-plan-4b-evaluator-design.md` (891 lines, 14-item decision log)
- **Implementation plan**: `.claude/plans/2026-04-22-plan-4b-evaluator.md` (1157 lines, 55 tasks × 14 parts)

Plan 4A completed artifacts (for reference / patterns to follow):
- `.claude/plans/2026-04-17-plan-1-foundation-login.md`
- `.claude/plans/2026-04-18-plan-2-rbac-trpc.md`
- `.claude/plans/2026-04-18-plan-3-ui-docker-e2e.md`
- `.claude/plans/2026-04-20-plan4a-gateway-design.md`
- `.claude/plans/2026-04-20-plan-4a-gateway.md`

## Pre-implementation review items flagged

Things I noticed myself while writing the plan — worth the user looking at before implementation begins, because they could cost fix rounds if missed:

1. **Part 5 Task 5.2 — LLM self-gateway call loopback concurrency**
   The evaluator runs LLM Deep Analysis by calling `http://localhost:3002/v1/messages` with a dedicated api_key. This request goes through the normal request pipeline including per-user concurrency slot acquisition (Plan 4A §3.1 Step 4). If the evaluator's dedicated api_key belongs to a system user, its slot is isolated — fine. But verify at impl time that the provisioned internal api_key's `user_id` is NOT a real member, OR that we explicitly bypass the user-slot step for `llm_eval_enabled` path. Otherwise evaluator traffic could deadlock with normal user traffic during high-usage periods.

2. **Part 10 Task 10.1 — CASCADE on GDPR bodies_and_reports scope**
   `evaluation_reports.user_id` has `ON DELETE RESTRICT` (inherited from Plan 4A conventions; §2.4 in 4B design). When scope = `bodies_and_reports`, we `DELETE FROM evaluation_reports WHERE user_id = X` — which does NOT conflict with RESTRICT because RESTRICT only fires if someone tries to delete the referenced user. The worker deletes the reports themselves (child rows), which is fine.
   **Check:** but confirm that deleting reports also doesn't leave orphaned rows elsewhere — search for other tables FK'ing to `evaluation_reports.id`.

3. **Part 2 Task 2.4 — Signal collector test coverage is "at least 3 fixtures per collector"**
   That's minimum for confidence; for `iteration_count` (which walks conversation turns) and `client_mix` (UA parsing has edge cases), consider ≥ 5 fixtures at implementation time.

4. **Part 9 Task 9.1 — Platform default rubric translation from CLI**
   The CLI's `templates/eval-standard.json` has 2 sections (`interaction`, `risk`). Gateway signals can backfill most but not all — e.g. CLI uses `gitCommits`/`linesAdded`, which gateway can't see at all. Part 9 Task 9.1 says "drop or replace". This choice should be deliberate (not just dropped) — the replacement signal set should keep the rubric's evaluation spirit. Worth a pre-impl review of the specific mapping.

5. **Part 3 Task 3.2 — Truncation priority order is asymmetric**
   When overall body exceeds 256KB, truncation priority is: `attempt_errors > thinking > tool_result.content.tail > response_body.tail`. This drops attempt_errors FIRST which means lost debugging signal for failover cases. Consider flipping: drop `response_body.tail` before `attempt_errors` since errors are often ~1KB and carry unique debug info that can't be reconstructed. User to decide.

6. **Part 5 LLM cost attribution** — the LLM eval calls land in `usage_logs` under `llm_eval_account_id` + `llm_eval_key` (dedicated api_key). The `evaluation_reports.llm_cost_usd` field on each report must be populated from the final `total_cost` of the loopback call. Verify at impl: the loopback gateway call's `usage_logs` row's `total_cost` is fetched back by the evaluator worker (via the returned `X-Request-Id` → query `usage_logs`) before upserting the report.

## Suggested resume command for next session

```
繼續 Plan 4B 執行。讀 .claude/plans/2026-04-22-plan-4b-handoff.md
review 6 個 pre-implementation 項目後，從 Part 1 Task 1.1 開始。
建新分支 feat/plan-4b-evaluator 從 main 切出。
繼續 subagent-driven 模式（Plan 4A 已驗證的 rhythm：
  implementer → 並行 spec-review + code-quality-review → next task）。
```

## Checks to run at Part boundaries

```bash
pnpm turbo run lint typecheck test --filter=@aide/db --filter=@aide/auth \
  --filter=@aide/config --filter=@aide/gateway-core --filter=@aide/evaluator \
  --filter=@aide/gateway --filter=@aide/api --filter=@aide/web
```

For Part 3+ (body capture) + Part 4+ (evaluator worker) + Part 10 (GDPR), integration tests need Postgres + Redis via testcontainers. Local running not strictly required — CI `evaluator-integration` job from Part 11 will be the authoritative gate.

## Lessons from Plan 4A to carry forward

- **Name collision check at Task 1.1** — Plan 4A hit `accounts` collision with NextAuth. Before creating any new schema symbol, grep the existing schema. (Schemas in 4B: `rubrics`, `requestBodies`, `evaluationReports`, `gdprDeleteRequests` — none collide per quick check, but verify at implementation.)
- **Drizzle `uuidv7()` doesn't exist** — use `.defaultRandom()` (gen_random_uuid). All 4 new 4B schemas already use `.defaultRandom()` in the plan.
- **tRPC router feature-flag gate must be tertiary, not sole** — Part 13 specifies this for `ENABLE_EVALUATOR`. Must also gate at UI + orchestration layers.
- **gateway-core export convention** — `main`/`types` → `dist/` (Part 2 Task 2.1 already specifies mirroring this).

## Task tracker

All Plan 4A Part tasks are completed (#22-35, plus #36-40 for 4B brainstorm+design+plan). Task 40 (writing-plans) is the last closed one.

Next session should create a fresh Part-level task list for 4B execution (Parts 1-14 as separate tasks similar to how Plan 4A was tracked).

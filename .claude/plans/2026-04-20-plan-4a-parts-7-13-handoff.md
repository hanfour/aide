# Plan 4A Parts 7-13 Handoff — 2026-04-20

Session paused after Part 6 (PR #7) submitted with 2 review fixes landed. Resume here.

## Repo state

- Working dir: `/Users/hanfourhuang/ai-dev-eval`
- Main branch: `main` at `ba8fb45` (PR #6 / Part 5 merged)
- Current branch: `feat/plan-4a-part-6-streaming` at `730af55` (PR #7 / Part 6 + fixes; **OPEN, awaiting merge**)
- Open PR: https://github.com/hanfour/aide/pull/7

**Before starting Part 7:** wait for PR #7 to merge to main, then `git checkout main && git pull && git checkout -b feat/plan-4a-part-7-usage-log`.

## Design + implementation plan

- **Design spec**: `.claude/plans/2026-04-20-plan4a-gateway-design.md` (1146 lines, 27-item decision log)
- **Implementation plan**: `.claude/plans/2026-04-20-plan-4a-gateway.md` (1841 lines, 48 tasks × 13 parts)

## Progress: 29 / 48 tasks done (Parts 1-6 ✅ in flight)

### Parts merged to main

- **PR #4** — Part 1 (6 tasks) + Part 2 (8 tasks): schema, RBAC extension, gateway-core utilities (62 tests)
- **PR #5** — Part 3 (4) + Part 4 (6): Fastify scaffold + env + apiKeyAuth + metrics + Redis layer (slots/wait/idem/sticky/failureMode)
- **PR #6** — Part 5 (4): selectAccounts, resolveCredential, undici upstream, /v1/messages MVP

### Open PR (Part 6 — awaiting merge)

- **PR #7** — Part 6 (7 tasks): SSE parser, smart buffer, failover loop, OAuth inline refresh, OAuth cron, /v1/chat/completions, streaming on /v1/messages
- 7 commits + 1 fix commit (`730af55`); 119 unit + 71 integration (+1 skip) tests; ~5000 LOC diff

### Parts remaining (19 tasks across 7 parts)

- **Part 7** (4) — BullMQ usage log worker + same-txn quota update + inline fallback + billing audit
- **Part 8** (4) — `apps/api` admin tRPC routers: accounts / apiKeys / usage + wire into appRouter
- **Part 9** (6) — `apps/web` admin UI: accounts list/create, api_key dialog, one-time URL landing, usage pages
- **Part 10** (4) — Dockerfile.gateway + compose extension + release matrix + CI integration job
- **Part 11** (2) — docs/GATEWAY.md + SELF_HOSTING update + apps/gateway/README
- **Part 12** (3) — Playwright E2E specs + smoke-gateway.sh
- **Part 13** (1) — v0.3.0 tag + README + CHANGELOG

## Outstanding TODOs in source (deferred from Parts 5-6, to land in 7+)

Grep `TODO(part-` in `apps/gateway/src/`:

| TODO | Location | Lands in |
|---|---|---|
| `gw_*` Prometheus counters/gauges (slot, queue, idem, sticky, redis errors, oauth dead) | various | Part 7 (alongside usage worker) |
| `usage_logs` INSERT + `api_keys.quota_used_usd` UPDATE in same txn | messages.ts, chatCompletions.ts | **Part 7** |
| Wait queue admission control | both routes | Part 7 follow-up or 8 |
| User concurrency slot (needs `users.concurrency` schema column) | both routes | Plan 4D |
| Sticky session lookup | both routes | Plan 4B/4C |
| Idempotency cache check | both routes | Plan 4B/4C |
| `fastify-raw-body` for byte-exact upstream forwarding | messages.ts | nice-to-have |
| `/v1/chat/completions` streaming wiring (anthropicToOpenaiStream translator) | chatCompletions.ts | Part 7 follow-up or 8 |
| `OAUTH_TOKEN_URL` env override (so route-level OAuth tests can inject fake server) | env.ts + oauthRefresh.ts | tiny follow-up |

## Skipped tests with rationale

- `apps/gateway/tests/routes/chatCompletions.integration.test.ts` — ONE `it.skip("inline OAuth refresh — needs OAUTH_TOKEN_URL env override")` test. Behavior IS fixed in source (`maybeRefreshOAuth` is called per attempt); only the route-level integration test for it is skipped. Coverage exists at the `oauthRefresh.integration.test.ts` level (13 tests).

## Learnings carried forward

### Patterns proven in Parts 3-6

1. **Subagent-driven development with two-stage review** (spec compliance → code quality) caught real bugs every PR. Continue.
2. **Implementer reports occasionally over-claim**; always verify with `git log --stat`, `pnpm test`, `grep -n`. The user has caught at least 4 incidents where wiring/test was claimed but missing.
3. **Per-part PR cadence works** (Parts 3+4 in one PR, Part 5 in own, Part 6 in own). Keep this — bigger PRs slow review and increase regression risk.
4. **Lockfile in same commit** as deps — implementers tend to commit src + deps but skip lockfile. Always check `git status` after dispatch.
5. **Inline Lua scripts as TS const strings** (not separate `.lua` files) — `tsc` doesn't copy non-TS assets to `dist/`. `apps/gateway/src/redis/lua/*.ts` files export string consts.
6. **NodeNext + verbatimModuleSyntax** — sibling imports use `.js` even in TS files; `import * as fm` + `(fm as any).default ?? fm` interop helper for CJS deps that don't tree-shake right (e.g., fastify-metrics).
7. **undici v6 not v8** — undici 8 requires Node 22; this repo's `engines.node = ">=20"` so use `^6.21.0`.
8. **Drizzle UPDATE rowCount** — node-postgres returns it via `(result as { rowCount?: number }).rowCount`; useful for CAS operations.

### Bug categories that surfaced (and the fix patterns)

| Class | Example PRs | Fix pattern |
|---|---|---|
| Wiring claimed but missing | PR #5 (Part 4 redisPlugin not in buildServer), PR #6 (Issue 1 — gateway main bypassed parseServerEnv), PR #7 (chatCompletions skipped maybeRefreshOAuth) | Always verify in user-facing entrypoint, not just unit tests |
| Race conditions across query→use boundaries | PR #6 Issue 2 (selectAccountIds → bare-id reload) | Return full row from the eligibility-checked query; never re-load by id |
| Missing CAS on concurrent writes | PR #7 Issue 2 (persistRefresh) | Read prev value, CAS in WHERE, throw on rowCount=0 |
| Soft-delete filter dropped in JOINs | PR #5 fix (organizations.deletedAt in apiKeyAuth) | Always check `isNull(<table>.deletedAt)` for org-scoped queries |
| Spec-stated early exits skipped | PR #6 Issue 1 (no GATEWAY_MAX_BODY_BYTES on Fastify, no model validation pre-pipeline) | Walk through design pipeline steps; gate them at Fastify config or top of route |

## Suggested resume command for next session

```
繼續 Plan 4A。讀 .claude/plans/2026-04-20-plan-4a-parts-7-13-handoff.md.
1. 確認 PR #7 (https://github.com/hanfour/aide/pull/7) 已 merge 到 main
2. git checkout main && git pull && git checkout -b feat/plan-4a-part-7-usage-log
3. 從 Part 7 Task 7.1 開始（BullMQ queue + usage-log job schema）
4. 繼續 subagent-driven 模式（implementer → spec reviewer → code quality reviewer）
```

If PR #7 is NOT yet merged when resuming: review it first, address any new findings on `feat/plan-4a-part-6-streaming`, then push, then merge.

## Checks to run at Part boundaries

```bash
pnpm turbo run lint typecheck test \
  --filter=@aide/db --filter=@aide/auth --filter=@aide/gateway-core \
  --filter=@aide/gateway --filter=@aide/api --filter=@aide/config

# Integration tests (need Docker for testcontainers)
pnpm -F @aide/gateway test:integration
```

For Part 8+ when apps/api gets new routers, also run:
```bash
pnpm -F @aide/api test
pnpm -F @aide/web e2e   # only when Part 12 lands new specs
```

## Part 7 quick brief

Plan lines 1528-1576. 4 tasks:

- **7.1** BullMQ queue setup + `usage-log` job schema
- **7.2** Worker — batch insert (100 rows / 1s flush) with same-txn quota update on `api_keys.quota_used_usd`
- **7.3** Inline fallback when `queue.add()` rejects (Redis down) — same INSERT+UPDATE inline; metric `gw_usage_enqueue_fallback_total`
- **7.4** Billing sanity audit + monotonicity metric

Design refs:
- Section 5.1 (lines 553-590) — usage log pipeline architecture
- Section 4.7 (line 511) — strict failure mode for billing-critical paths
- Schema: `usage_logs` table already exists from Part 1 (see `packages/db/src/schema/usageLogs.ts` — 50+ columns including cost computation fields)
- Pricing: `@aide/gateway-core/pricing` already implemented in Part 2 — use `getPricing(model)` to compute costs

The "ENQUEUE then return" semantic means the route handler enqueues a job containing all the data needed to compute cost + write the row, returns immediately, and the worker batches inserts. Part 7's challenge is keeping billing integrity (no silent loss on Redis hiccup) while not blocking request response.

Add deps: `bullmq` (already a transitive dep via... actually verify; likely needs to be added direct).

After Part 7, both routes (`messages.ts`, `chatCompletions.ts`) need to be modified to enqueue usage-log jobs after successful upstream completion. Touch points:
- After `result.body` is sent to client → enqueue `{requestId, apiKeyId, accountId, orgId, teamId, requestedModel, upstreamModel, platform, surface, status, usage: parsed.usage, stream}`
- For streaming: extract usage from `message_start.usage` + `message_delta.usage` (parse SSE events) before enqueue

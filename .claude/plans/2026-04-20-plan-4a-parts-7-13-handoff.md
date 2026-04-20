# Plan 4A Parts 7-13 Handoff — 2026-04-20

PR #8 (Part 7 infrastructure) merged. Resume here. Route wiring for Part 7 is the immediate next step before moving to Part 8.

## Repo state

- Working dir: `/Users/hanfourhuang/ai-dev-eval`
- Main branch: `main` at `2210fc5` (PR #8 merged)
- No active branch; all PR branches deleted on origin
- All 8 PRs (#4–#8) for Parts 1-7 (infra) merged

**To start the Part 7 route-wiring follow-up:**
```bash
git checkout main && git pull
git checkout -b feat/plan-4a-part-7-route-wiring
```

## Design + implementation plan

- **Design spec**: `.claude/plans/2026-04-20-plan4a-gateway-design.md` (1146 lines, 27-item decision log)
- **Implementation plan**: `.claude/plans/2026-04-20-plan-4a-gateway.md` (1841 lines, 48 tasks × 13 parts)

## Progress: 33 / 48 tasks done (Parts 1-7 infra ✅)

### Parts merged to main

- **PR #4** — Part 1 (6) + Part 2 (8): schema, RBAC extension, gateway-core utilities (62 tests)
- **PR #5** — Part 3 (4) + Part 4 (6): Fastify scaffold + env + apiKeyAuth + metrics + Redis layer
- **PR #6** — Part 5 (4): selectAccounts, resolveCredential, undici upstream, /v1/messages MVP
- **PR #7** — Part 6 (7): SSE parser, smart buffer, failover loop, OAuth inline refresh + cron, /v1/chat/completions, /v1/messages streaming
- **PR #8** — Part 7 (4 infra tasks): BullMQ usage-log queue + Zod payload, batched worker (100 jobs / 1s flush, same-txn quota update via `ON CONFLICT DO NOTHING RETURNING`), inline DB fallback when Redis is down, hourly billing audit (1% Bernoulli, drift + monotonicity counters; samples revoked keys too). 8 commits + 2 review-fix commits. 149 unit + 92 integration tests (+1 pre-existing skip)

### Parts remaining (15 tasks across 7 parts + 1 follow-up)

- **Part 7 follow-up** — Route wiring: instantiate queue/worker/audit in `server.ts`; wire `enqueueUsageLog` into `messages.ts` (non-streaming + streaming SSE usage extraction) and `chatCompletions.ts` (non-streaming only — chat-completions streaming returns 501 until Part 8+). **Start here next session.**
- **Part 8** (4) — `apps/api` admin tRPC routers: accounts / apiKeys / usage + wire into appRouter
- **Part 9** (6) — `apps/web` admin UI: accounts list/create, api_key dialog, one-time URL landing, usage pages
- **Part 10** (4) — Dockerfile.gateway + compose extension + release matrix + CI integration job
- **Part 11** (2) — docs/GATEWAY.md + SELF_HOSTING update + apps/gateway/README
- **Part 12** (3) — Playwright E2E specs + smoke-gateway.sh
- **Part 13** (1) — v0.3.0 tag + README + CHANGELOG

## Outstanding TODOs in source (deferred from Parts 5-7)

Grep `TODO(part-` in `apps/gateway/src/`:

| TODO | Location | Lands in |
|---|---|---|
| `gw_*` Prometheus counters/gauges (slot, queue, idem, sticky, redis errors, oauth dead) | various | Part 7 follow-up (queue/dlq) + later parts |
| `usage_logs` INSERT + `api_keys.quota_used_usd` UPDATE in same txn | messages.ts, chatCompletions.ts | **Part 7 follow-up (route wiring)** |
| Wait queue admission control | both routes | Part 7 follow-up or 8 |
| User concurrency slot (needs `users.concurrency` schema column) | both routes | Plan 4D |
| Sticky session lookup | both routes | Plan 4B/4C |
| Idempotency cache check | both routes | Plan 4B/4C |
| `fastify-raw-body` for byte-exact upstream forwarding | messages.ts | nice-to-have |
| `/v1/chat/completions` streaming wiring (anthropicToOpenaiStream translator) | chatCompletions.ts | Part 8 or later |
| `OAUTH_TOKEN_URL` env override (so route-level OAuth tests can inject fake server) | env.ts + oauthRefresh.ts | tiny follow-up |

## Skipped tests with rationale

- `apps/gateway/tests/routes/chatCompletions.integration.test.ts` — ONE `it.skip("inline OAuth refresh — needs OAUTH_TOKEN_URL env override")` test. Behavior IS fixed in source (`maybeRefreshOAuth` is called per attempt); only the route-level integration test for it is skipped. Coverage exists at the `oauthRefresh.integration.test.ts` level (13 tests).

## Part 7 infrastructure (PR #8) — what's available to wire

New files in `apps/gateway/src/workers/`:

- **`usageLogQueue.ts`** — exports:
  - `USAGE_LOG_QUEUE_NAME` = `"usage-log"`, `USAGE_LOG_QUEUE_PREFIX` = `"aide:gw"` → namespaced as `aide:gw:usage-log:*`
  - `UsageLogJobPayload` (Zod schema; ALL `usage_logs` columns required, costs as decimal strings, `failedAccountIds` as `string[]` non-null)
  - `createUsageLogQueue({ connection, prefix?, defaultJobOptions? })` factory
  - `enqueueUsageLog(queue, payload, opts?)` → `Promise<{ jobId, persistence: "queued" | "inline" }>`. Optional `opts.fallback = { db, logger, metrics? }` — on `queue.add` rejection, runs `writeUsageLogBatch(db, [payload])` inline; dual failure logs `gw_usage_persist_lost` + `metrics.inc?.()`, re-throws original BullMQ error.
- **`usageLogWorker.ts`** — `class UsageLogWorker` lifecycle (`start/stop/refreshMetrics`); batcher: Worker concurrency=batchSize, in-process flush on size or time. Updates `gw_queue_depth` + `gw_queue_dlq_count` gauges.
- **`writeUsageLogBatch.ts`** — shared txn helper used by worker AND inline fallback. INSERT uses `.onConflictDoNothing({ target: usageLogs.requestId }).returning(...)`; quota UPDATE only sums actually-inserted rows (so retried duplicates dedup silently and don't double-bump).
- **`billingAudit.ts`** — `class BillingAudit` lifecycle (`start/stop/runOnce`). Hourly cron, `TABLESAMPLE BERNOULLI(N)` over ALL api_keys (active + revoked), per-row drift + monotonicity counters.

New metrics (already exposed on `fastify.gwMetrics`):

| Metric | Type | When |
|---|---|---|
| `gw_usage_persist_lost_total` | counter | inline DB fallback ALSO fails |
| `gw_billing_drift_total` | counter | per-key audit drift > $0.01 |
| `gw_billing_monotonicity_violation_total` | counter | per-key audit `actual < expected` |
| `gw_queue_depth` | gauge | wait+active counts (worker refreshes after each flush + on stop) |
| `gw_queue_dlq_count` | gauge | failed jobs (refreshed same as above) |

## Part 7 route-wiring brief (NEXT)

Three logical pieces, plan as 3 sub-tasks:

### Sub-task A — `server.ts` lifecycle

- Build a dedicated ioredis connection (no `keyPrefix` — it conflicts with BullMQ's Lua scripts; pass `{ host, port, password, ... }` parsed from `REDIS_URL`).
- Instantiate the queue via `createUsageLogQueue`. Decorate `fastify.usageLogQueue`.
- Instantiate `UsageLogWorker` with the same connection + `fastify.db` + `fastify.log` + metrics. `start()` it.
- Instantiate `BillingAudit` with `fastify.db` + `fastify.log` + metrics. `start()` it.
- `fastify.addHook("onClose", ...)` to `stop()` the worker, `stop()` the audit, close the queue + dedicated connection.
- Skip all this when `ENABLE_GATEWAY=false` (matches existing pattern).

### Sub-task B — Wire non-streaming on `messages.ts` + `chatCompletions.ts`

Touch points (after upstream success, before `reply.send`):

1. Compute cost via `@aide/gateway-core` `loadPricing()` + `resolveCost(pricing, model, tokens)`. Pricing map can be cached at server startup or per-request.
2. Build `UsageLogJobPayload`:
   - `requestId: req.id`
   - `userId: req.gwUser!.id`, `apiKeyId: req.apiKey!.id`, `accountId: account.id`, `orgId: req.apiKey!.orgId`, `teamId: req.apiKey!.teamId ?? null`
   - `requestedModel: body.model`, `upstreamModel: parsed.model` (from response), `platform: "anthropic" | "openai"`, `surface: "messages" | "chat-completions"`
   - Token counts from `parsed.usage` (anthropic: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`; openai: needs translator-side mapping)
   - Costs as decimal strings (use `String(num)` carefully or `num.toFixed(10)`)
   - `rateMultiplier: "1.0"`, `accountRateMultiplier: "1.0"` (placeholder until per-key/per-account rate cards land)
   - `stream: false`, `statusCode: result.status`, `durationMs: Date.now() - startedAt`
   - `firstTokenMs: null`, `bufferReleasedAtMs: null` (streaming-only, leave null for non-stream)
   - `upstreamRetries: 0` (or pull from failover loop's attempt count if exposed)
   - `failedAccountIds: []` (or list of attempted but failed account ids if exposed)
   - `userAgent: req.headers["user-agent"] ?? null`, `ipAddress: req.ip ?? null`
3. Call `enqueueUsageLog(fastify.usageLogQueue, payload, { fallback: { db: fastify.db, logger: req.log, metrics: fastify.gwMetrics.usagePersistLostTotal } })`.

   Note: the metrics API was renamed in the PR #8 review (`inc()`, not `persistLostInc()`), so `fastify.gwMetrics.usagePersistLostTotal` can be passed directly without an adapter.
4. Remove the `TODO(part-7): usage_logs INSERT...` comment from messages.ts.

### Sub-task C — Streaming SSE usage extraction on `messages.ts`

The `runStreamingFailover` path passes raw upstream bytes through `SmartBuffer` to the client. To enqueue usage, you need to ALSO parse the SSE stream to extract `usage` from `message_start` (first event) and `message_delta` (final usage update).

- The parser is in `@aide/gateway-core` (`parseAnthropicSSE`).
- One option: wrap `SmartBuffer.push` in a side-channel that feeds bytes through the SSE parser, accumulating usage. After the final `message_delta`, capture the final usage object.
- After `await buffer.commit()`, build the payload (with `stream: true`, `firstTokenMs: <ms when first chunk pushed>`, `bufferReleasedAtMs: <ms when buffer.commit ran>`) and enqueue.
- Edge: client disconnect mid-stream — should we still enqueue? Yes, with whatever usage we managed to extract; statusCode = 200 if upstream completed before client disconnect, else 499 client-disconnect.

Risk-prone — plan to write the SSE-tap as a small helper in `runtime/` and unit-test it independently before wiring into the streaming route.

### Tests for the wiring follow-up

- Per-route integration test: full request cycle, assert `usage_logs` row created with correct fields + `api_keys.quota_used_usd` bumped.
- Streaming integration test: stream completes → row created with `stream: true` and correct `firstTokenMs`/`bufferReleasedAtMs`.
- Negative: enqueue fails (Redis down) → fallback runs → row still created.
- Update existing `messages.routes.integration.test.ts` / `chatCompletions.routes.integration.test.ts` — they currently assert response shape but ignore usage_logs. Add an "after success, usage_logs row exists" assertion.

## Learnings carried forward

### Patterns proven in Parts 3-7

1. **Subagent-driven development with two-stage review** (spec compliance → code quality) catches real bugs every PR. Continue.
2. **Implementer reports occasionally over-claim**; always verify with `git log --stat`, `pnpm test`, `grep -n`. The user has caught at least 5 incidents where wiring/test was claimed but missing OR where review missed a real concurrency-style bug (PR #8 duplicate-poison batch + revoked-audit blind spot).
3. **Two-stage review is not enough for cross-task data-integrity issues** — a per-task spec/code review can't see "what happens when this batch contains a previously-committed retry alongside new jobs". For batch-mutation features, explicitly add a "what happens on retry of partial commit" prompt to the spec reviewer brief, OR ask the user to do a final pre-PR pass.
4. **Per-part PR cadence works** — Parts 3+4 in one PR, Parts 5/6/7 each in own. Part 7 was infra-only with route wiring split to a follow-up branch (recommended pattern for risky cross-cutting wiring).
5. **Lockfile in same commit** as deps — implementers tend to commit src + deps but skip lockfile. Always check `git status` after dispatch.
6. **Inline Lua scripts as TS const strings** (not separate `.lua` files) — `tsc` doesn't copy non-TS assets to `dist/`. `apps/gateway/src/redis/lua/*.ts` files export string consts.
7. **NodeNext + verbatimModuleSyntax** — sibling imports use `.js` even in TS files; `import * as fm` + `(fm as any).default ?? fm` interop helper for CJS deps that don't tree-shake right (e.g., fastify-metrics).
8. **undici v6 not v8** — undici 8 requires Node 22; this repo's `engines.node = ">=20"` so use `^6.21.0`.
9. **Drizzle UPDATE rowCount** — node-postgres returns it via `(result as { rowCount?: number }).rowCount`; useful for CAS operations.
10. **BullMQ + ioredis `keyPrefix`** — does NOT work. BullMQ needs a connection without `keyPrefix`; pass a fresh ioredis instance or `RedisOptions` and let BullMQ own its prefix via the queue's `prefix` option.
11. **`INSERT ... ON CONFLICT DO NOTHING RETURNING`** — the right pattern for batched idempotent writes; combine with a Set-based filter on the input payloads to keep downstream logic (like quota updates) consistent with what was actually inserted. Without it, ANY duplicate in a batch poisons the whole transaction.

### Bug categories that surfaced (and the fix patterns)

| Class | Example PRs | Fix pattern |
|---|---|---|
| Wiring claimed but missing | PR #5 (Part 4 redisPlugin not in buildServer), PR #6 (Issue 1 — gateway main bypassed parseServerEnv), PR #7 (chatCompletions skipped maybeRefreshOAuth) | Always verify in user-facing entrypoint, not just unit tests |
| Race conditions across query→use boundaries | PR #6 Issue 2 (selectAccountIds → bare-id reload) | Return full row from the eligibility-checked query; never re-load by id |
| Missing CAS on concurrent writes | PR #7 Issue 2 (persistRefresh) | Read prev value, CAS in WHERE, throw on rowCount=0 |
| Soft-delete filter dropped in JOINs | PR #5 fix (organizations.deletedAt in apiKeyAuth) | Always check `isNull(<table>.deletedAt)` for org-scoped queries |
| Spec-stated early exits skipped | PR #6 Issue 1 (no GATEWAY_MAX_BODY_BYTES on Fastify, no model validation pre-pipeline) | Walk through design pipeline steps; gate them at Fastify config or top of route |
| Batched-write duplicate poison | PR #8 (HIGH from user review) | INSERT ... ON CONFLICT DO NOTHING RETURNING; filter downstream effects (quota update) by what was actually inserted |
| Audit blind spot via filter | PR #8 (MEDIUM from user review) | When auditing, default to "include everything" unless there's a clear reason to exclude. Filters in audit queries are anti-patterns. |

## Suggested resume command for next session

```
繼續 Plan 4A。讀 .claude/plans/2026-04-20-plan-4a-parts-7-13-handoff.md.
1. git checkout main && git pull
2. git checkout -b feat/plan-4a-part-7-route-wiring
3. 先做 Sub-task A（server.ts lifecycle），然後 Sub-task B（non-streaming wiring），最後 Sub-task C（streaming SSE usage extraction）
4. 繼續 subagent-driven 模式（implementer → spec reviewer → code quality reviewer）
```

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

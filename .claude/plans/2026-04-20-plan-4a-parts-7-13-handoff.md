# Plan 4A Parts 7-13 Handoff — 2026-04-21

PR #10 (Part 8 admin tRPC routers) merged. PR #9 (Part 7 route wiring) still open against main. Part 9 (web UI) is the next net-new work.

## Repo state

- Working dir: `/Users/hanfourhuang/ai-dev-eval`
- Main branch: `main` at `30214a0` (PR #10 merged via fast-forward)
- No active branch; all merged PR branches deleted on origin
- **Open PRs**: PR #9 — Part 7 route wiring. Branch `feat/plan-4a-part-7-route-wiring` still on origin. Pending merge or rebase.
- All 9 PRs (#4–#8, #10) for Parts 1-8 merged

**To start Part 9 (web UI):**
```bash
git checkout main && git pull
git checkout -b feat/plan-4a-part-9-admin-ui
```

(Part 9 only touches `apps/web/`. No conflicts with PR #9's open branch — that one only touches `apps/gateway/`.)

## Design + implementation plan

- **Design spec**: `.claude/plans/2026-04-20-plan4a-gateway-design.md` (1146 lines, 27-item decision log)
- **Implementation plan**: `.claude/plans/2026-04-20-plan-4a-gateway.md` (1841 lines, 48 tasks × 13 parts)

## Progress: 41 / 48 tasks done (Parts 1-8 ✅)

### Parts merged to main

- **PR #4** — Part 1 (6) + Part 2 (8): schema, RBAC extension, gateway-core utilities (62 tests)
- **PR #5** — Part 3 (4) + Part 4 (6): Fastify scaffold + env + apiKeyAuth + metrics + Redis layer
- **PR #6** — Part 5 (4): selectAccounts, resolveCredential, undici upstream, /v1/messages MVP
- **PR #7** — Part 6 (7): SSE parser, smart buffer, failover loop, OAuth inline refresh + cron, /v1/chat/completions, /v1/messages streaming
- **PR #8** — Part 7 (4 infra tasks): BullMQ usage-log queue + Zod payload, batched worker, inline DB fallback, hourly billing audit. 149 unit + 92 integration tests
- **PR #10** — Part 8 (4 tasks): admin tRPC routers (accounts, apiKeys, usage) + appRouter wiring. Plumbs `env`/`redis`/`ipAddress`/`logger` through `TrpcContext` via `createContextFactory({ env, redis })`. New helpers: `_shared.ts` `assertTeamBelongsToOrg`. CI build extended to `--filter=@aide/gateway-core`. 5 unit + 98 integration tests

### Open PRs (not yet merged)

- **PR #9** — Part 7 follow-up route wiring: `server.ts` lifecycle (queue/worker/audit) + non-streaming wiring on both routes + streaming SSE usage extraction on `/v1/messages` via push-mode `StreamUsageExtractor`. 184 unit + 98 integration tests (+1 pre-existing skip). Branch `feat/plan-4a-part-7-route-wiring` at HEAD `015ba77` (not refreshed since opened).

### Parts remaining (7 tasks across 5 parts)

- **Part 9** (6) — `apps/web` admin UI: accounts list/create, api_key dialog, one-time URL landing, usage pages. **Start here next session.**
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

## Part 8 admin tRPC routers (PR #10) — what's available to consume

`appRouter` now exposes `accounts`, `apiKeys`, `usage` namespaces. Web UI (Part 9) calls these via the existing tRPC client.

### `accounts.*`

- `list({ orgId })` → `UpstreamAccount[]` (no credential material — `credential_vault` is a separate table)
- `get({ id })` → row OR `NOT_FOUND`
- `create({ orgId, teamId?, name, platform: "anthropic", type: "api_key" | "oauth", schedulable?, priority?, concurrency?, rateMultiplier?, notes?, credentials })` → row. Credentials encrypted via `encryptCredential` in same txn as `upstream_accounts` insert.
- `update({ id, name?, notes?, schedulable?, priority?, concurrency?, rateMultiplier? })` — patch fields.
- `rotate({ id, credentials })` → `{ id, rotatedAt }`. Re-encrypts; `NOT_FOUND` if vault row is missing.
- `delete({ id })` → `{ ok: true }` (soft-delete, sets `deletedAt = NOW()`, `schedulable = false`).

RBAC: `account.read / create / update / rotate / delete`. All endpoints throw `NOT_FOUND` when `ENABLE_GATEWAY=false`.

### `apiKeys.*`

- `issueOwn({ name, teamId? })` → `{ id, prefix, raw }`. Raw shown ONCE. orgId resolved from caller's earliest-joined org. Verifies `teamId.orgId === resolvedOrgId` if provided.
- `issueForUser({ orgId, targetUserId, name, teamId? })` → `{ id, prefix, revealUrl }`. NO raw. Verifies `targetUserId` is a member of `orgId` (cross-tenant guard) AND `teamId.orgId === orgId`. Revealable URL: `${GATEWAY_BASE_URL}/api-keys/reveal/<token>`. Raw stashed in Redis at `aide:gw:key-reveal:<token>` 24h TTL.
- `revealViaToken({ token })` → `{ id, prefix, raw, name }`. CAS-enforced single-reveal. Scoped to `userId === ctx.user.id` (target user only — protects against misdirected URL).
- `listOwn()` → own non-revoked keys (scrubbed; no key material).
- `listOrg({ orgId })` → org's non-revoked keys + `revealedAt` + `revealTokenExpiresAt` so admin UI can show "pending reveal" vs "claimed". No `keyHash` / `revealTokenHash` / `revealedByIp`.
- `revoke({ id })` → `{ ok: true }` (soft-revoke). Double-revoke → NOT_FOUND.

RBAC: `api_key.issue_own / issue_for_user / list_own / list_all / revoke`. All endpoints throw `NOT_FOUND` when `ENABLE_GATEWAY=false`.

### `usage.*`

- `summary({ scope, from?, to? })` → `{ totalRequests, totalCostUsd, totalInputTokens, totalOutputTokens, totalCacheCreationTokens, totalCacheReadTokens, byModel: [...] }`. **Cost decimals are STRINGS** (full `numeric(20,10)` precision). Defaults: `to = now`, `from = now - 30d`.
- `list({ scope, from?, to?, page?, pageSize? })` → `{ items, page, pageSize, totalCount }`. Excludes `failedAccountIds` / `userAgent` / `ipAddress`. ORDER BY `createdAt DESC, id DESC`. `pageSize` cap 200.

Scope discriminator: `{ type: "own" } | { type: "user", userId, orgId } | { type: "team", teamId, orgId } | { type: "org", orgId }`.

RBAC: `usage.read_own / read_user / read_team / read_org`.

### TrpcContext additions (Part 8)

`createContextFactory({ env, redis })` binds startup deps once. Per-request fields now include `env: ServerEnv`, `redis: Redis`, `ipAddress: string | null`, `logger: TrpcLogger`. `protectedProcedure` forwards all of them explicitly.

## Part 9 web UI brief (NEXT)

Six tasks (plan lines 1629-1690). All under `apps/web/`. No conflicts with PR #9's open branch (only touches `apps/gateway/`).

### Task 9.1 — Accounts list page
- Files: `apps/web/src/app/dashboard/organizations/[id]/accounts/page.tsx` + `apps/web/src/components/accounts/AccountList.tsx`
- Lists from `trpc.accounts.list({ orgId })`. Status badges (Apple design tokens). Row actions: rotate / edit / delete dropdown. RequirePerm gate on `account.read`.

### Task 9.2 — Account create page
- Files: `apps/web/src/app/dashboard/organizations/[id]/accounts/new/page.tsx` + `apps/web/src/components/accounts/AccountCreateForm.tsx`
- React-hook-form + zod. Fields: name, platform (select: anthropic), type (radio: api_key / oauth), scope (org or team picker), credentials (textarea with format hint per type).

### Task 9.3 — API Key list + self-issue dialog
- Modify `apps/web/src/app/dashboard/profile/page.tsx` — add API Keys section
- Create `apps/web/src/components/apiKeys/ApiKeyList.tsx` + `ApiKeyCreateDialog.tsx`
- Create dialog → submit → show one-time reveal panel + copy button + warning. After close, prefix only. Revoke with confirm.

### Task 9.4 — Admin-issue key (one-time URL)
- Files: `apps/web/src/app/dashboard/organizations/[id]/members/[uid]/api-keys/page.tsx` + `apps/web/src/components/apiKeys/AdminIssueDialog.tsx`
- Admin fills form → submits → UI shows one-time URL + copy button + 24h expiry note. Admin never sees raw key.

### Task 9.5 — Reveal landing page
- Files: `apps/web/src/app/api-keys/reveal/[token]/page.tsx`
- Server component calls `trpc.apiKeys.revealViaToken({ token })`. Displays raw + copy button. Second open → "Already revealed".
- Note: target user must be logged in (router enforces `userId === ctx.user.id`). Add a "log in to claim" gate if unauthenticated.

### Task 9.6 — Usage dashboards
- Files: `apps/web/src/app/dashboard/organizations/[id]/usage/page.tsx` + `apps/web/src/app/dashboard/profile/usage/page.tsx` + `apps/web/src/components/usage/UsageChart.tsx`
- Time range picker, tab switch (by team / by member), top-20 spenders, request drill-down via `usage.list`.
- **CRITICAL: cost decimals are strings.** Use `Decimal.js` / `BigDecimal` before formatting — `Number(...)` truncates past ~$1B totals.

### Tests for Part 9

- Component-level: react-testing-library for forms + dialogs (mock tRPC client).
- E2E in Part 12 (Playwright): full self-issue + admin-issue flows.

## Learnings carried forward

### Patterns proven in Parts 3-8

1. **Subagent-driven development with two-stage review** (spec compliance → code quality) catches real bugs every PR. Continue.
2. **Implementer reports occasionally over-claim**; always verify with `git log --stat`, `pnpm test`, `grep -n`. The user has caught at least 7 incidents where wiring/test was claimed but missing OR where review missed real concurrency / cross-tenant bugs (PR #8 duplicate-poison batch + revoked-audit blind spot; PR #10 cross-tenant credential issuance + missing teamId binding).
3. **Two-stage review is not enough for cross-task / cross-table integrity issues.** A per-task spec/code review can't see "what happens when this batch contains a previously-committed retry" or "is targetUserId actually in orgId". For batch-mutation features, add "what happens on retry of partial commit" to the spec reviewer brief. For multi-table writes, add "verify every FK input belongs to the parent scope" — schema FKs are independent and don't enforce org/team membership.
4. **Per-part PR cadence works** — Parts 3+4 in one PR, Parts 5/6/7/8 each in own. Part 7 was infra-only with route wiring split to a follow-up branch (recommended pattern for risky cross-cutting wiring).
5. **Lockfile in same commit** as deps — implementers tend to commit src + deps but skip lockfile. Always check `git status` after dispatch.
6. **CI build filters must include every workspace package consumed by tests.** PR #10 broke CI integration because `apps/api` started importing `@aide/gateway-core` (whose `main` points at `dist/`), but `.github/workflows/ci.yml` only built `db / auth / config`. When adding a new workspace dep to a tested package, audit the CI build filters.
7. **Inline Lua scripts as TS const strings** (not separate `.lua` files) — `tsc` doesn't copy non-TS assets to `dist/`. `apps/gateway/src/redis/lua/*.ts` files export string consts.
8. **NodeNext + verbatimModuleSyntax** — sibling imports use `.js` even in TS files; `import * as fm` + `(fm as any).default ?? fm` interop helper for CJS deps that don't tree-shake right (e.g., fastify-metrics).
9. **undici v6 not v8** — undici 8 requires Node 22; this repo's `engines.node = ">=20"` so use `^6.21.0`.
10. **Drizzle UPDATE rowCount** — node-postgres returns it via `(result as { rowCount?: number }).rowCount`; useful for CAS operations.
11. **BullMQ + ioredis `keyPrefix`** — does NOT work. BullMQ needs a connection without `keyPrefix`; pass a fresh ioredis instance or `RedisOptions` and let BullMQ own its prefix via the queue's `prefix` option.
12. **`INSERT ... ON CONFLICT DO NOTHING RETURNING`** — the right pattern for batched idempotent writes; combine with a Set-based filter on the input payloads to keep downstream logic (like quota updates) consistent with what was actually inserted. Without it, ANY duplicate in a batch poisons the whole transaction.
13. **Context plumbing via factory pattern** — `createContextFactory({ env, redis })` binds startup-time deps once; per-request `createContext` reads them from closure. Avoids re-parsing env / re-allocating clients per request. `protectedProcedure` must EXPLICITLY forward all narrowed fields in `next({ ctx })` rather than relying on tRPC v11's implicit ctx-merge — defends against future framework behavior changes.
14. **Decimal `numeric(20,10)` columns must be `::text` cast in SELECT** to preserve precision; client receives strings and uses `Decimal.js` / `BigDecimal`. `Number(...)` silently truncates past ~15 significant digits.
15. **No-op `scrubX` helpers are deceptive.** Either implement with explicit allowed-column list, or delete and rely on the explicit SELECT projection. Reviewers reading `rows.map(scrub)` assume sanitization happens.

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
| Cross-tenant credential issuance | PR #10 (HIGH from user review) | RBAC check (caller has perms in orgId) does NOT prove the resource (targetUserId) belongs to that org. Add explicit membership SELECT before INSERT. |
| Cross-org child-FK input | PR #10 (HIGH from user review) | Independent FKs (api_keys.team_id → teams) don't enforce org binding. Add `assertTeamBelongsToOrg(db, teamId, orgId)` before any insert that takes both. |
| CI build filter incomplete | PR #10 (BLOCKER from user review) | When a tested package gains a workspace dep that builds to dist/, audit `.github/workflows/ci.yml` build filters and add the new package. |

## Suggested resume command for next session

```
繼續 Plan 4A。讀 .claude/plans/2026-04-20-plan-4a-parts-7-13-handoff.md.
1. git checkout main && git pull
2. git checkout -b feat/plan-4a-part-9-admin-ui
3. 從 Task 9.1（Accounts list page）開始
4. 繼續 subagent-driven 模式（implementer → spec reviewer → code quality reviewer）
```

PR #9 is still open — let it land independently OR rebase onto main if it fell behind. Part 9 doesn't conflict.

## Checks to run at Part boundaries

```bash
pnpm turbo run lint typecheck test \
  --filter=@aide/db --filter=@aide/auth --filter=@aide/gateway-core \
  --filter=@aide/gateway --filter=@aide/api --filter=@aide/config --filter=@aide/web

# Integration tests (need Docker for testcontainers)
pnpm -F @aide/gateway test:integration
pnpm -F @aide/api test:integration

# E2E (only when Part 12 lands new specs)
pnpm -F @aide/web e2e
```

# Plan 4A Parts 3-13 Handoff — 2026-04-20

Session paused intentionally after Parts 1-2 merged to main. Resume here.

## Repo state

- Working dir: `/Users/hanfourhuang/ai-dev-eval`
- Main branch: `main` at `fcc4d10` (Plan 4A Parts 1-2 merged via PR #4)
- Current branch: `main`
- No WIP; clean tree

## Design + implementation plan

- **Design spec**: `.claude/plans/2026-04-20-plan4a-gateway-design.md` (1146 lines, 27-item decision log)
- **Implementation plan**: `.claude/plans/2026-04-20-plan-4a-gateway.md` (1841 lines, 48 tasks × 13 parts)

## Progress: 14 / 48 tasks (Parts 1-2 ✅)

### Parts done (merged to main)
- **Part 1** (6 tasks) — 4 new schemas (upstream_accounts, credential_vault, api_keys, usage_logs), migration 0001, RBAC extended with 15 new action types
- **Part 2** (8 tasks) — `@aide/gateway-core` package: pricing / state machine / AES-GCM cipher / HMAC API key / 3 translators (request + non-stream response + streaming with incremental tool_calls). 62 tests.

### Parts remaining (34 tasks)
- **Part 3** (4) — `apps/gateway` Fastify scaffold + env + API-key auth middleware + /metrics
- **Part 4** (6) — Redis layer: slots (Lua ZSET), wait queue, idempotency, sticky, failure mode
- **Part 5** (4) — account selection + credential resolve + undici non-stream passthrough + `/v1/messages` route
- **Part 6** (7) — 🔥 streaming + smart buffer + failover loop + OAuth refresh inline + cron + `/v1/chat/completions` + streaming wire-up on messages
- **Part 7** (4) — BullMQ usage log worker + same-txn quota update + inline fallback + billing audit
- **Part 8** (4) — `apps/api` admin tRPC routers: accounts / apiKeys / usage + wire into appRouter
- **Part 9** (6) — `apps/web` admin UI: accounts list/create, api_key dialog, one-time URL landing, usage pages
- **Part 10** (4) — Dockerfile.gateway + compose extension + release matrix + CI integration job
- **Part 11** (2) — docs/GATEWAY.md + SELF_HOSTING update + apps/gateway/README
- **Part 12** (3) — Playwright E2E specs + smoke-gateway.sh
- **Part 13** (1) — v0.3.0 tag + README + CHANGELOG

## Learnings from Parts 1-2 to carry forward

### Bug fixes that surfaced during execution (all already fixed + merged)

1. **`accounts` collides with NextAuth** — DO NOT use `accounts` for anything else. Plan 4A's gateway table is `upstream_accounts` / `upstreamAccounts`. When adding FKs (usage_logs.account_id → upstream_accounts.id), use the renamed symbol.
2. **`uuidv7()` does not exist** — always use `.defaultRandom()` (Postgres `gen_random_uuid()`). All 4 gateway schemas already use this.
3. **`api_key.revoke` policy** — action payload MUST include `orgId` + `ownerUserId` (not just apiKeyId). `can()` requires self OR org_admin. Future `apiKeys.revoke` tRPC router must load the key first, then pass full context into `can()`.
4. **Translator text preservation** — assistant messages with both `content` + `tool_calls` need to emit text blocks first, then tool_use blocks. Not just tool_use.
5. **Malformed tool args throw** — `translateOpenAIToAnthropic` rejects invalid JSON in `function.arguments` via `parseToolArgs` helper. Don't silent-fallback.

### Code-review observations to expect for Parts 3+

- Real Fastify routes: check Redis failure mode (strict vs lenient) is correctly enforced
- Streaming code: check `AbortSignal` propagation to undici on client disconnect
- Smart buffer: check that post-commit errors don't retry (design Section 3.4)
- Usage log worker: check same-txn INSERT + UPDATE pattern for billing integrity (design Section 5.1)
- OAuth refresh cron: check per-instance jitter + exponential backoff on fail_count

## Suggested resume command for next session

```
繼續 Plan 4A。讀 .claude/plans/2026-04-20-plan-4a-parts-3-13-handoff.md
從 Part 3 Task 3.1 開始（apps/gateway 的 Fastify scaffold + /health + feature flag gate）。
建新分支 feat/plan-4a-parts-3-6 從 main 切出。
繼續 subagent-driven 模式。
```

## Checks to run at Part boundaries

```bash
pnpm turbo run lint typecheck test --filter=@aide/db --filter=@aide/auth --filter=@aide/gateway-core --filter=@aide/gateway --filter=@aide/api
```

For Part 6+7 onwards, integration tests need Postgres + Redis. CI job `gateway-integration` is in Plan Part 10 — local testing may need docker compose for a DB + Redis.

## Tasks progress tracker

All 13 Part-level tasks are already in TaskList (#22-34), with #23 + #25 marked completed (Parts 1-2). Next session should:
- TaskUpdate #24 to in_progress when starting Part 3
- Complete Part 3, then move to #22 (Part 4), etc.

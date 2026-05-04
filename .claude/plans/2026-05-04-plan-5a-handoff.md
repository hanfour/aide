# Plan 5A — Session Handoff (2026-05-04)

Live status of Plan 5A implementation across PRs.  Read this first
when resuming work in a fresh session.  Spec docs are in
`.claude/plans/2026-04-28-plan-5a-design.md` (design) and
`.claude/plans/2026-04-28-plan-5a-implementation.md` (per-task plan).

This supersedes `2026-04-29-plan-5a-handoff.md`.

---

## Progress: 19 PRs merged, route layer complete

| # | PR | Status | Merged commit | Scope |
|---|---|---|---|---|
| Pre | #30 | merged | `38b8eea` | fix drizzle 0007 snapshot id collision |
| 1 | #31 | merged | `f26ce10` | Migration 0008 — `account_groups` + `api_keys.group_id` + `subscription_tier` |
| 2 | #32 | merged | `a014b5a` | Migration 0009 — `model_pricing` + pricing seed + `pricingLookup` + `computeCost` |
| 3 | #33 | merged | `b372453` | Migration 0010 — `usage_logs` 4 token classes + `actual_cost_usd` + 2-stage billing rewrite |
| 4 | #34 | merged | `1f3480d` | Part 4 — OAuth 4-piece abstraction (`OAuthRefreshAPI`, `RefreshPolicy`, registry, vault facade) |
| 5 | #35 | merged | `26ef6c0` | Part 5 — OpenAI Codex OAuth impl |
| Followup | #36 | merged | `24f00b0` | Migration 0011 — `cache_read_per_million_micros` (closes #33 KNOWN DIVERGENCE) |
| 6  | #37 | merged | `91779a0` | Part 6 — request body translators + pivots + dispatch |
| 6b | #40 | merged | `6172b3d` | Part 6b — response (non-stream) body translators |
| 6c | #41 | merged | `e26e192` | Part 6c — stream translators + SSE pipe |
| 7  | #38 | merged | `a042ff9` | Part 7 — 3-layer account scheduler (replaces `failoverLoop`) |
| 8  | #39 | merged | `51e2754` | Part 8 — group context middleware + autoRoute dispatch helper |
| 9a | #42 | merged | `d8d3445` | `/v1/chat/completions` streaming SSE (anthropic upstream) |
| 9b | #43 | merged | `e401766` | `/v1/responses` route — anthropic upstream non-stream |
| 9c | #44 | merged | `0748f6d` | `/v1/responses` streaming SSE (anthropic upstream) |
| 9d | #45 | merged | `bb580e3` | `/v1/responses` openai upstream non-stream passthrough |
| 9e | #46 | merged | `c7c6a2b` | `/v1/responses` openai upstream streaming SSE |
| 9f | #47 | merged | `1a06766` | Codex CLI alias `/backend-api/codex/responses` |
| 9g | #48 | merged | `d1c339a` | `/v1/messages` autoRoute wrap + openai-platform branch (non-stream) |
| 9h | #49 | merged | `6b3ba32` | `/v1/messages` openai-stream branch |
| 9i | #50 | merged | `163b3a3` | `/v1/chat/completions` openai-platform branch (Chat ↔ Responses pivot) |
| 9j | #51 | open  | (pending) | failover-loop boilerplate consolidation (`runtime/sseErrorEvents` + `runtime/upstreamErrorMapping`) |

**After PR 9j merges, all of Part 9 is shipped.** All four inbound
routes (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`,
`/backend-api/codex/responses`) now dispatch by group platform and
support both Anthropic and OpenAI upstreams in stream + non-stream
modes, with cross-format pivots wired in.

---

## Remaining work

### Part 10 — ImpersonateChrome + tier sync (~6 tasks)

OpenAI account `subscription_tier` (`free` / `plus` / `pro`)
auto-detection for cost-band telemetry.

- **10.1** `runtime/impersonateChrome.ts` — undici Agent with the same
  TLS fingerprint sub2api uses (JA3 string + cipher suite list).
  Required so OpenAI's `chat.openai.com/api/me` endpoint accepts
  the request — vanilla `fetch()` gets a 403.
- **10.2** `runtime/fetchPlanType.ts` — calls `chat.openai.com/api/me`
  through `impersonateChrome` using the account's session token
  (NOT the Codex token), parses `account.subscription_plan.title`,
  maps to one of `free`/`plus`/`pro`/`teams`/`enterprise` (table
  in design §10.3).
- **10.3** Background tier-sync job (BullMQ queue + worker). Polls
  daily for openai-platform accounts. Updates
  `upstream_accounts.subscription_tier` column.
- **10.4** OAuth-callback hook calls `fetchPlanType` synchronously on
  account creation so the tier is known before first scheduling
  decision.
- **10.5** Wire `subscription_tier` into the scheduler's tier-aware
  preference (Layer 2 sticky already exists; tier preference is a
  nice-to-have for future Pro-routing).
- **10.6** Tests: ImpersonateChrome unit (TLS fingerprint regression),
  fetchPlanType integration (recorded sub2api fixtures), tier-sync
  worker integration.

**Forward deps**: Task 5.5/5.6/5.7/5.8 (callback listener + admin
tRPC + `completeOAuthFlow` + `probeAccount`) deferred from PR #35
should land **with** Part 10.4 since they're the same flow.

### Part 11 — Admin UI (~10 tasks)

`apps/web` work — depends on Parts 9 + 10.

- **11.1–11.3** Account groups CRUD pages (list / create / edit).
- **11.4–11.5** OAuth flow modal (browser-redirect + callback URL +
  token-paste fallback for sub2api).
- **11.6–11.7** Cost-dashboard breakdown by group + provider
  (`usage_logs` already has `account_id` + `platform` for pivot).
- **11.8** Account tier badge (renders `subscription_tier`).
- **11.9** Group-routing health view (per-account success rate from
  `usage_logs`).
- **11.10** Admin tRPC router for above (`apps/api/src/trpc/routers/`).

### Part 12 — E2E + docs + UPGRADE (~8 tasks)

Final polish before v0.6.0.

- **12.1** Playwright E2E for the OpenAI provider flow (login →
  add account → run inference → see usage row).
- **12.2** Smoke tests against a real OpenAI org (gated by env).
- **12.3** Runbook: how to add a new platform.
- **12.4** Runbook: rotating an OpenAI client_id.
- **12.5** Runbook: triaging `account_at_capacity` 503s.
- **12.6** `docs/UPGRADE-v0.6.0.md` — migration steps for self-hosted
  ops (run migrations 0008–0011, no breaking config).
- **12.7** Update `README.md` provider matrix.
- **12.8** Mark all forward-debt items closed; cut v0.6.0.

### Forward debt (still owed from earlier PRs)

- **Task 4.6** background refresh scheduler cron wiring — deferred
  from PR #34. Land with Part 7's BG scheduler boot or
  `apps/gateway/src/server.ts`.
- **Tasks 5.5/5.6/5.7/5.8** (OAuth callback listener + admin tRPC
  + `completeOAuthFlow` + `probeAccount`) — deferred from PR #35.
  Land with Part 10.4 (same flow). `probeAccount` needs Part 9's
  `/v1/responses` route (now landed).
- **OAuth metrics** in `OAuthRefreshAPI` — `gw_oauth_refresh_success_total{platform}`
  etc. Deferred from PR #34. Land with Part 7's BG scheduler.
- **`usage_log` row assertions in route integration tests** — at
  parity-gap across PR 9b/9d/9e/9g/9h/9i. Test mode currently
  no-ops the queue. Either inject a fake `usageLogQueue` fixture
  or wire the inline-fallback path. Worth a dedicated PR.
- **Manual smoke against a real OpenAI client** — non-stream and
  stream paths against a Codex CLI / Python SDK / Anthropic SDK.
  Best done as part of Part 12.1's E2E rig.

---

## Working conventions (unchanged from prior handoff)

### Branch naming
`feat/plan-5a-prN<letter?>-<short-descriptor>` —
e.g. `feat/plan-5a-pr9i-chat-completions-openai`.
Followups: `feat/plan-5a-pr32-followup-cache-read-pricing`.
Fix-only PRs: `fix/<descriptor>`.

### Commit format
Conventional commits:
- `feat(plan-5a): <PR title prefix>` for feature PRs
- `refactor(plan-5a): <descriptor> (PR Nx)` for consolidation PRs
- `fix(plan-5a-prN): <descriptor>` for review-fix commits within a PR
- `fix(<scope>): <description>` for bug fixes

Body should include:
- What this PR delivers
- What's deferred + why
- Test results (unit + integration counts — usually `38 files / 379
  passed` unit + `32 files / 241 passed / 1 skipped` integration as
  of PR 9j)
- References to plan / design sections

### Review cadence (tight loop)
1. Open PR, watch CI green via `gh pr checks N`.
2. User runs `/review` → I write structured review with HIGH /
   MEDIUM / LOW issues + concrete fixes.
3. User says `fix all` → I commit + push fixes (single commit,
   `fix(plan-5a-prN): …`).
4. CI green → user authorizes squash merge → I
   `gh pr merge N --squash --delete-branch`.
5. Sync main, branch for next PR.

### Push auth
Repo `hanfour/aide` requires the `hanfour` GitHub account.  If push
returns 403, run `gh auth switch -u hanfour` before retrying.

### Patterns codified in Part 9 (use for Part 10+)

- **autoRoute factory pattern**: each cross-platform route uses
  `makeXxxAnthropicHandler(app, opts)` + `makeXxxOpenaiHandler(app,
  opts)` factories returning closures, then wires them via
  `autoRoute({ anthropic, openai })` in the route registration.
  See `routes/messages.ts` and `routes/chatCompletions.ts` for the
  template.
- **Synthetic Anthropic usage shape for pricing**: when the upstream
  provider isn't Anthropic, build a synthetic Anthropic-shaped
  response via `runtime/syntheticUsageShapes.ts:buildSyntheticAnthropicUsage`
  so `emitUsageLog`'s pricing path runs unchanged. Synthetic id
  prefix per surface: `synthetic:openai-chat:`,
  `synthetic:openai-stream-chat:`, `synthetic:openai-stream-messages:`,
  `synthetic:openai-stream:` (responses).
- **`usageLogInboundPlatformForSurface(surface)`**: codifies the
  "platform = inbound URL space" contract on `usage_log` rows.
  `/v1/messages` → `anthropic`; `/v1/chat/completions` and
  `/v1/responses` → `openai`. Upstream provider is recoverable via
  `accountId` join to `upstream_accounts.platform`.
- **`withSlotAndCredential(app, opts, account, requestId, fn)`**:
  the slot+OAuth boilerplate from PR 9d M1 fix. All new openai-branch
  handlers use this; older anthropic-branch handlers still inline
  the boilerplate (could be DRYed in a future cleanup PR).
- **AbortController plumbing**: every streaming + non-stream upstream
  call wires `req.raw.once("close", () => ac.abort())` and passes
  `signal: ac.signal` to `callUpstream*`. Cleanup in `finally` via
  `req.raw.off("close", onClose)` (non-stream) or
  `req.raw.removeListener("close", onClose)` (stream — aliased).
- **PR 9j shared helpers** (`runtime/upstreamErrorMapping.ts` +
  `runtime/sseErrorEvents.ts`) — use these in new handlers instead
  of inlining:
  - `parseRetryAfterHeader(raw)` for Retry-After header parsing.
  - `buildUpstreamHttpError(upstream, opts?)` for the failover-loop
    throwable shape.
  - `serializeAnthropicSseError` / `serializeChatSseError` /
    `serializeResponsesSseError` for SSE error chunks.
  - `failoverErrorPair(err)` for `kind`/`message` extraction.
  - `respondStreamFailoverCollapse(reply, err, requestId, serializer)`
    for the post-hijack catch block.

### Known wire-format quirks
- **OpenAI Responses error events** use `error.kind` (NOT `error.type`)
  on the inner object. The Anthropic + Chat shapes use `error.type`.
  See `serializeResponsesSseError` vs the other two.
- **OpenAI Chat streaming** error chunks have NO `event:` prefix —
  they're raw `data: {…}\n\n` lines. Anthropic and Responses both
  use `event: error\ndata: …\n\n`.
- **`request_id`** is included inside `error.{request_id}` on every
  flavour for ops correlation. SDK clients ignore unknown fields,
  so this is forward-compatible.

### Pre-existing technical debt (not blocking)
- `apps/gateway/tests/redis/client.test.ts` has a typecheck error
  around `ENABLE_FACET_EXTRACTION` not being declared in env shape.
  Unrelated to Plan 5A. Filter `| grep -v ENABLE_FACET` when
  checking typecheck output.
- `apps/api/src/trpc/routers/evaluator.ts:96` and
  `tests/factories/caller.ts:77` have pre-existing TS errors that
  were present on main when Plan 5A started. Not in scope.

---

## How to enter the next session

```
讀 .claude/plans/2026-05-04-plan-5a-handoff.md。
從 [Part 10 ImpersonateChrome | forward-debt OAuth callback | …]
動工。工作分支 feat/plan-5a-prN-<descriptor>。
```

Then for the chosen task:

1. Read the relevant Part's task list in
   `.claude/plans/2026-04-28-plan-5a-implementation.md`
2. Cross-reference `2026-04-28-plan-5a-design.md` for design decisions
3. `git checkout main && git pull && git checkout -b feat/plan-5a-prN-<descriptor>`
4. Implement → `pnpm --filter @aide/<package> test` + `typecheck` clean
5. Commit (conventional format) → `git push -u origin <branch>`
6. `gh pr create --base main` with structured body
7. Watch CI: `gh pr checks N` until all green
8. Wait for user `/review` → fix → merge

### Test runners
- `pnpm --filter @aide/db test` — db package vitest
- `pnpm --filter @aide/db build` — required after schema change before consuming packages typecheck
- `pnpm --filter @aide/gateway-core test` — pure unit tests
- `pnpm --filter @aide/gateway test` — gateway unit tests (379 passing as of PR 9j)
- `pnpm --filter @aide/gateway test:integration` — gateway integration (241 passing + 1 skipped)
- `pnpm --filter @aide/api test:integration tests/integration/migrations/` — testcontainers postgres:16-alpine

### Known fixtures + helpers
- `apps/api/tests/factories/db.ts` → `setupTestDb()` returns testDb with full migration replay
- `apps/api/tests/factories/{org,user}.ts` → `makeOrg`, `makeUser`
- `apps/gateway/tests/factories/usageLogPayload.ts` → `makeUsageLogJobPayload(overrides)` (PR #34 review fix)
- `apps/gateway/tests/routes/messages.integration.test.ts:seedGroup` and
  `apps/gateway/tests/routes/chatCompletions.integration.test.ts:seedGroup`
  — copy this pattern when adding tests for cross-platform routes.

---

## Recommended next PR

**Forward-debt PR 5b (OAuth callback + admin tRPC + probeAccount)**
is now unblocked since Part 9 (`/v1/responses`) shipped — `probeAccount`
can hit a real route. This combined with Part 10.4 lets the OAuth flow
land end-to-end in one focused PR.

Alternatively, **Part 10.1–10.2 (ImpersonateChrome + fetchPlanType)**
is a pure runtime addition with no UI dependency — good if you want to
avoid touching `apps/web` yet.

Avoid jumping straight to **Part 11 (admin UI)** — it touches both
`apps/web` and `apps/api`, multiple files per task, and most usefully
consumes Part 10's tier sync.

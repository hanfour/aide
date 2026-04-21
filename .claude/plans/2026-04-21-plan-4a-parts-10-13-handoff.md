# Plan 4A Parts 10-13 Handoff — 2026-04-21 (post PR #11)

PR #11 (Part 9 admin UI) merged via fast-forward. All web UI + admin tRPC consumers are live on main. Parts 10-13 are infra + docs + E2E + release — no more net-new app code.

## Repo state

- Working dir: `/Users/hanfourhuang/ai-dev-eval`
- Main branch: `main` at `3b2be85` (Merge commit for PR #11)
- No active branch; all Part 9 work merged, feature branch deleted on origin
- **Open PRs**: **PR #9** — Part 7 route wiring. Branch `feat/plan-4a-part-7-route-wiring` still on origin (HEAD `015ba77`, not refreshed). Main has moved ~5 commits since it opened. **Rebase-or-merge decision needed before Part 10.**
- All 11 merged PRs (#4–#8, #10, #11) cover Parts 1-9

**To start Part 10 (Docker):**
```bash
git checkout main && git pull
git checkout -b feat/plan-4a-part-10-docker
```

(Part 10 only touches `docker/`, `.github/workflows/`. No conflicts with PR #9.)

## Design + implementation plan

- **Design spec**: `.claude/plans/2026-04-20-plan4a-gateway-design.md` (1146 lines, 27-item decision log)
- **Implementation plan**: `.claude/plans/2026-04-20-plan-4a-gateway.md` (1841 lines, 48 tasks × 13 parts)
- **Prior handoff**: `.claude/plans/2026-04-20-plan-4a-parts-7-13-handoff.md` (superseded by this doc)

## Progress: 47 / 48 tasks done (Parts 1-9 ✅)

### Parts merged to main

- **PR #4** — Part 1 (6) + Part 2 (8): schema, RBAC extension, gateway-core utilities (62 tests)
- **PR #5** — Part 3 (4) + Part 4 (6): Fastify scaffold + env + apiKeyAuth + metrics + Redis layer
- **PR #6** — Part 5 (4): selectAccounts, resolveCredential, undici upstream, /v1/messages MVP
- **PR #7** — Part 6 (7): SSE parser, smart buffer, failover loop, OAuth inline refresh + cron, /v1/chat/completions, /v1/messages streaming
- **PR #8** — Part 7 (4 infra tasks): BullMQ usage-log queue + Zod payload, batched worker, inline DB fallback, hourly billing audit. 149 unit + 92 integration tests
- **PR #10** — Part 8 (4 tasks): admin tRPC routers (accounts, apiKeys, usage) + appRouter wiring. Plumbs `env`/`redis`/`ipAddress`/`logger` through `TrpcContext` via `createContextFactory({ env, redis })`. 5 unit + 98 integration tests
- **PR #11** — Part 9 (6 tasks): `apps/web` admin UI — accounts list/create, self-issue + admin-issue API keys, reveal landing, usage dashboards. +2888/-95 across 30 files. 15 commits (6 feat + 7 review-refactor + 2 holistic polish). 99 integration tests

### Open PRs (not yet merged)

- **PR #9** — Part 7 follow-up route wiring: `server.ts` lifecycle (queue/worker/audit) + non-streaming wiring on both routes + streaming SSE usage extraction on `/v1/messages` via push-mode `StreamUsageExtractor`. 184 unit + 98 integration tests (+1 pre-existing skip). Branch `feat/plan-4a-part-7-route-wiring` at HEAD `015ba77` (stale vs main; rebase/merge first before Part 10 work lands).

### Parts remaining (1 task + 10 new across 4 parts)

- **Part 10** (4) — Dockerfile.gateway + compose extension + release matrix + CI integration job. **Start here next session.**
- **Part 11** (3) — docs/GATEWAY.md + SELF_HOSTING update + apps/gateway/README
- **Part 12** (2) — Playwright E2E specs + smoke-gateway.sh
- **Part 13** (1) — v0.3.0 tag + README + CHANGELOG

## Outstanding TODOs in source (deferred from earlier parts)

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
| Account `rotate` / `edit` form UI (spec'd as stubs in Part 9; now show `Soon` disabled items) | `apps/web/src/components/accounts/AccountList.tsx:AccountRowActions` | post-4A (Plan 4B+) |
| Per-request detail modal on usage drill-down | `apps/web/src/components/usage/UsageTable.tsx` | post-4A |
| Team/member scope tabs on org usage page | `apps/web/src/app/dashboard/organizations/[id]/usage/page.tsx` | post-4A |

## Part 9 follow-up backlog (from PR #11 review, deferred by the reviewer)

1. **Playwright E2E smoke: admin-issues → user-reveals happy path**. Reviewer explicitly deferred to Part 12 ("could defer to Part 12"). **Add this as one of the Part 12 specs.**
2. **`StatusBadge` unify across 3 files** (`accounts/status.tsx` + inline in `ApiKeyList.tsx` + inline in `UsageTable.tsx`). Domain-distinct state machines use subtly different dark-mode opacity tokens (`/10` vs `/15`) — not critical. Refactor candidate for post-4A polish.
3. **`account.update` / `account.rotate` admin forms**. Not a Plan 4A line item; Part 9 shipped stubs ("Soon" disabled items). Candidates for Plan 4B or post-4A.

## Part 9 infrastructure (PR #11) — what's available to consume

New web libs:
- `apps/web/src/lib/time.ts` — `toDate(v)` + `formatRelative(ts)` (tRPC-without-superjson timestamp normalization). Use in any new dashboard component that renders relative times.
- `apps/web/src/lib/money.ts` — `toDecimal(v)` + `formatUsd(v, fractionDigits?)` + `sumUsd(values)`. **Required** for any cost-decimal rendering (tRPC returns `numeric(20,10)` as strings; `Number(...)` truncates past ~$1B). Hand-rolls thousands separator to avoid `Intl.NumberFormat` number-coercion.

New auth subpath exports:
- `packages/auth/package.json` exposes `./rbac`, `./rbac/check`, `./rbac/actions`. Import from subpaths in any client-side code — `@aide/auth` root re-exports `drizzle-adapter` which pulls `pg` into the client bundle and breaks `next build`.

New web deps:
- `decimal.js ^10.4.3` (correctness-critical).

Consumed tRPC surface (Part 8 → Part 9):
- `accounts.list/get/create/update/rotate/delete` — list + create pages wired; rotate/edit/delete via dropdown (rotate/edit are `Soon` stubs).
- `apiKeys.issueOwn/issueForUser/revealViaToken/listOwn/listOrg/revoke` — all wired. `listOrg` gained optional `userId` filter in PR #11 (reduces browser exposure for the admin-per-user view).
- `usage.summary/list` — KPI cards + chart + paginated drill-down.

## Part 10 brief (NEXT)

Four tasks (plan lines 1694-1728). Touches `docker/` + `.github/workflows/` only.

### Task 10.1 — `docker/Dockerfile.gateway`
- Files: `docker/Dockerfile.gateway`
- Multi-stage, mirrors `docker/Dockerfile.api` (pnpm deploy to `/out`, `node:20-alpine` runtime). Healthcheck: `wget -q -O- http://localhost:3002/health`.
- Commit: `feat(docker): multi-stage Dockerfile.gateway`

### Task 10.2 — Extend `docker-compose.yml` with `gateway` + `redis`
- Files: `docker/docker-compose.yml`
- Add `redis:7-alpine` service (always up — used by gateway + future features), `gateway` service under `profiles: [gateway]`. Wire env vars (secrets via `docker secrets` or `env_file: .env.secrets`). Depends on postgres healthy + migrate completed + redis healthy.
- Commit: `feat(docker): compose adds redis + gateway (under profile)`

### Task 10.3 — Extend `release.yml` matrix with `gateway`
- Files: `.github/workflows/release.yml` — add `gateway` to matrix.image
- Multi-arch already set up; just the matrix entry needed.
- Commit: `ci(release): build + push aide-gateway image`

### Task 10.4 — CI `gateway-integration` job
- Files: `.github/workflows/ci.yml` — add `gateway-integration` job
- Uses testcontainers for postgres + redis; runs `pnpm -F @aide/gateway test` + `pnpm -F @aide/gateway-core test`.
- Commit: `ci: gateway-integration job on testcontainers`

## Learnings carried forward (updated after PR #11)

### Patterns that continue to work

1. **Subagent-driven development with two-stage review** (spec compliance → code quality) + a final holistic review at branch-end catches real bugs every PR. Continue.
2. **Implementer reports occasionally over-claim.** PR #11 had 3 instances where implementer reported DONE but spec/code reviewer caught issues (stale OAuth error state, teams-loading hidden-select, missing `<th scope>`). Always verify with `git log --stat`, `pnpm test`, actual file reads.
3. **Fresh subagent per task** (no context pollution) + `SendMessage` skipped (not available in this env) → fix subagents re-dispatched with full context. Works fine; more tokens but each run is clean.
4. **Per-part PR cadence** — Part 9 landed as ONE PR with 15 commits (6 feat + 7 review-refactor + 2 holistic). Review cycles encode clearly in git history; easy to bisect a regression to the exact review round.
5. **Review pushback matters.** Reviewer on PR #11 pushed back on deferring the `listOrg userId` filter — I accepted and landed it in the same PR with +1 integration test. Better than shipping over-fetching behavior and fixing once caches are warm.

### Newly proven patterns (Part 9)

- **Subpath exports for client-safe imports** — `@aide/auth/rbac/*` avoids pulling `drizzle-adapter` → `pg` → `tls` into Next's client bundle. Additive (`.` root export unchanged); server consumers untouched. Pattern reusable whenever a shared package re-exports server-only modules from its main entry.
- **Decimal.js end-to-end for `numeric(20,10)` columns** — `Number(cost)` silently truncates past ~15 significant digits. `formatUsd` hand-rolls the thousands separator to avoid round-tripping through `Intl.NumberFormat`. Apply to any dashboard that renders `usage_logs` / `quota_usd` cost columns.
- **Credential-in-transit discipline on reveal surfaces** — raw key / one-time URL lives only in `useState`; dropped on any dialog-close path (Cancel / X / ESC / click-outside / Done) via `useEffect([open])`; `role="alert"` on warning banners consistent across 3 surfaces (self-issue dialog, admin-issue dialog, reveal landing page). Copy toast omits the value.
- **CAS + no-existence-leak on claim flow** — reveal landing page collapses all `NOT_FOUND` variants (invalid / wrong user / already claimed / expired) into one generic error card; server's CAS guarantees single-use; UI does not try to distinguish.
- **Explicit-click on mutation-triggering landing pages** — reveal page does NOT auto-fire on mount (unlike invite-accept). User may want incognito / verify-recipient / log-in-first. Different security contexts warrant different auto-fire policies.
- **Shared utility extraction is cheap at 2 duplicates, mandatory at 3** — `toDate`/`formatRelative` was ok inline after 9.1, duplicated at 9.3, extracted to `lib/time.ts` in the 9.3 review-refactor before a 3rd copy landed in 9.4.
- **`decimal.js` dep (10KB gzip) vs `recharts` dep (~300KB)** — add the correctness-critical lib, skip the display-polish lib. `UsageChart` is ~67 lines of SVG/CSS. "or similar" language in the spec permits this.

### Bug categories that surfaced in PR #11 (and fixes applied)

| Class | Example | Fix pattern |
|---|---|---|
| RHF stale validation state after field toggle | `AccountCreateForm` OAuth-JSON error persisting after type→api_key | `useEffect([type]) → clearErrors('credentials')` |
| RHF retained field value when select conditionally unmounts | `AccountCreateForm` `teamId` surviving scope→org | `useEffect([scopeType]) → setValue('teamId', '')` |
| Loading placeholder hidden during fetch → surprising silent default | `AdminIssueDialog` team select hidden while `teamsLoading` | Render disabled select with "Loading teams…" option |
| `mutateAsync` in `onSubmit` causes unhandled-rejection | `AdminIssueDialog` form | `issue.mutate(...)` (fire-and-forget; `onError` handles) |
| Over-fetch in admin-per-user list | `AdminApiKeyList` pulling all org keys | Server-side `userId?: uuid` filter on `listOrg` |
| Stub-via-toast reads as user error | `AccountList` row actions | Disabled dropdown item + muted "Soon" badge |
| pg client teardown race on testcontainer stop (CI-only flake) | `apiKeys.test.ts` uncaught `57P01` during container stop | Re-run passes; root-cause fix in test harness (lower priority) |

## Suggested resume command for next session

```
繼續 Plan 4A。讀 .claude/plans/2026-04-21-plan-4a-parts-10-13-handoff.md
1. 決定 PR #9 (Part 7 route wiring) 怎麼處理 — rebase 上 main 再 merge，或直接關閉重開
2. git checkout main && git pull
3. git checkout -b feat/plan-4a-part-10-docker
4. 從 Task 10.1 (docker/Dockerfile.gateway) 開始
5. 繼續 subagent-driven 模式（implementer → spec reviewer → code quality reviewer → holistic reviewer on branch end）
```

## Checks to run at Part boundaries

```bash
pnpm turbo run lint typecheck test \
  --filter=@aide/db --filter=@aide/auth --filter=@aide/gateway-core \
  --filter=@aide/gateway --filter=@aide/api --filter=@aide/config --filter=@aide/web

# Integration tests (need Docker for testcontainers)
pnpm -F @aide/gateway test:integration
pnpm -F @aide/api test:integration

# E2E (Part 12 will add specs)
pnpm -F @aide/web e2e
```

## Post-4A parking lot (won't be in v0.3.0)

Pulled from Part 9 review feedback + Part 4-8 deferrals. Capture so they don't get lost in a year.

- `StatusBadge` unify (see follow-up #2 above)
- Account `update` / `rotate` admin forms (see TODO table)
- Per-request usage detail modal (see TODO table)
- Team/member scope tabs on org usage page (`usage.summary` needs a `summaryByUser` variant first)
- `superjson` transformer on the tRPC client — would let `inferRouterOutputs` return `Date` instead of `string` for timestamp columns. Currently handled in `@/lib/time` and each helper's signature accepts `Date | string | null`.
- Audit other root `@aide/auth` imports in `apps/web` for subpath migration opportunities (code reviewer flagged as Minor #6 during PR #11).
- pg client teardown race in `apps/api` integration tests (CI-only flake on PR #11; re-run passed).

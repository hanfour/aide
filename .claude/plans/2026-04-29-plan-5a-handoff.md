# Plan 5A — Session Handoff (2026-04-29)

Live status of Plan 5A implementation across PRs.  Read this first when
resuming work in a fresh session.  Spec docs are in
`.claude/plans/2026-04-28-plan-5a-design.md` (design) and
`.claude/plans/2026-04-28-plan-5a-implementation.md` (per-task plan).

---

## Progress: 8 PRs merged, ~7 remaining

| # | PR | Status | Merged commit | Scope |
|---|---|---|---|---|
| Pre | #30 | merged | `38b8eea` | fix drizzle 0007 snapshot id collision |
| 1 | #31 | merged | `f26ce10` | Migration 0008 — `account_groups` + `api_keys.group_id` + `subscription_tier` |
| 2 | #32 | merged | `a014b5a` | Migration 0009 — `model_pricing` + 7-row seed + `pricingLookup` + `computeCost` |
| 3 | #33 | merged | `b372453` | Migration 0010 — `usage_logs` 4 token classes + `actual_cost_usd` + 2-stage billing rewrite |
| 4 | #34 | merged | `1f3480d` | Part 4 — OAuth 4-piece abstraction (`OAuthRefreshAPI`, `RefreshPolicy`, registry, vault facade) |
| 5 | #35 | merged | `26ef6c0` | Part 5 — OpenAI Codex OAuth impl (constants, service, refresher, provider, registry boot) |
| Followup | #36 | merged | `24f00b0` | Migration 0011 — `cache_read_per_million_micros` (closes PR #33 KNOWN DIVERGENCE) |
| 6 | #37 | merged | `91779a0` | Part 6 — request body translators + pivots + dispatch |

## Remaining work

Plan inventory sorted by recommended landing order.  Each row maps to a
single focused PR; some Part-N's were split into N + Nb + Nc per scope.

| Next | Plan task | PR title | Forward deps |
|---|---|---|---|
| 1 | Part 6 Task 6.7 | `feat(plan-5a): response (non-stream) body translators (PR 6b)` | none |
| 2 | Part 6 Tasks 6.9–6.11 | `feat(plan-5a): stream translators + SSE pipe + fixtures (PR 6c)` | needs SSE fixtures recorded from real upstream OR property-test approach |
| 3 | Part 7 (8 tasks) | `feat(plan-5a): 3-layer account scheduler (replaces failoverLoop)` | none — pure refactor |
| 4 | Part 8 (5 tasks) | `feat(plan-5a): group context middleware + autoRoute helper` | uses scheduler |
| 5 | Part 9 (7 tasks) | `feat(plan-5a): /v1/responses route + Codex CLI alias + chat completions streaming completion` | uses translators + scheduler + `pricingLookup` injection |
| 6 | Part 10 (6 tasks) | `feat(plan-5a): ImpersonateChrome + fetchPlanType + tier sync background job` | needs Part 9 for probe |
| 7 | Part 11 (10 tasks) | `feat(plan-5a): admin UI — account groups + OAuth flow modal + cost dashboard breakdown` | apps/web side; consumes Part 9 + Part 10 |
| 8 | Part 12 (8 tasks) | `feat(plan-5a): E2E + smoke + docs + UPGRADE-v0.6.0 + runbooks` | last; requires all preceding |

### Also still owed from earlier PRs (forward debt)

- **Task 4.6 background refresh scheduler cron wiring** — was deferred from PR #34 to "PR 5 + later".  Land it together with Part 9's gateway server boot or earlier as a dedicated PR.
- **Task 5.5 / 5.6 / 5.7 / 5.8 (callback listener + admin tRPC + completeOAuthFlow + probeAccount)** — deferred from PR #35 to "PR 5b".  Has forward deps on Part 9 (`/v1/responses` for probe) and Part 10 (ImpersonateChrome for `fetchPlanType`).  Probably easier to land **after** Parts 9 + 10 so no stubbing is needed.
- **Metrics emission in `OAuthRefreshAPI`** — `gw_oauth_refresh_success_total{platform}` etc.  Deferred from PR #34.  Land together with Part 7's BG scheduler.

---

## Working conventions (carry forward)

### Branch naming
`feat/plan-5a-prN-<short-descriptor>` — e.g. `feat/plan-5a-pr6-translators-request`.
Followups: `feat/plan-5a-pr32-followup-cache-read-pricing`.
Fix-only PRs: `fix/<descriptor>`.

### Commit format
Conventional commits:
- `feat(plan-5a): <PR title prefix>` for feature PRs
- `refactor(plan-5a): address PR review — <brief>` for review-fix commits
- `fix(<scope>): <description>` for bug fixes

Body should include:
- What this PR delivers
- What's deferred + why
- Test results (unit + integration counts)
- References to plan / design sections

### Review cadence (tight loop)
1. Open PR, watch CI green
2. User runs `/review` → I write structured review (HIGH/MEDIUM/LOW priority, numbered Issues, concrete fix proposals)
3. User says `fix all` (or specific subset) → I commit + push fixes in one commit
4. CI green → user authorizes squash merge → I `gh pr merge N --squash --delete-branch`
5. Sync main, branch for next PR

### Push auth
Repo `hanfour/aide` requires the `hanfour` GitHub account.  If push returns 403, run `gh auth switch -u hanfour` before retrying (a separate `HanfourHuangOneAD` account exists in `gh auth status` but lacks push perms).

### Scope cuts (lessons learned)
- **Big plan parts → split**: Part 5 has 9 tasks; we split into 5 (core 4-piece) + 5b (admin / callback / probe).  Part 6 has 11 tasks; we split into 6 (request translators) + 6b (response) + 6c (stream + fixtures).  Aim for ~ < 1500 LOC + < 10 test files per PR.
- **Forward-deps reveal stub-or-defer**: When Task A needs Task B that lives in a later PR, prefer to land Task A in a focused PR that doesn't import B yet (zero runtime wiring) rather than stubbing B.
- **Schema drift between TS + plan**: plan §X.Y SQL sometimes references columns that don't exist (e.g. `api_keys.deleted_at` is actually `revoked_at`).  Always grep the schema before writing migration SQL.
- **Plan inventory completeness gaps**: Plan §10.1 listed 4 translator filenames that already existed in 4A under different names; design §10.7 dispatch implied an `anthropicToChat` REQUEST translator that wasn't in any task list.  Cross-check design `dispatch` table before declaring "all the listed translators done".

### Pre-existing technical debt (not blocking)
- `apps/gateway/tests/redis/client.test.ts` has a typecheck error around `ENABLE_FACET_EXTRACTION` not being declared in env shape.  Unrelated to Plan 5A.  Filter `| grep -v ENABLE_FACET` when checking typecheck output.
- `apps/api/src/trpc/routers/evaluator.ts:96` and `tests/factories/caller.ts:77` have pre-existing TS errors that were present on main when Plan 5A started.  Not in scope.

---

## How to enter the next session

```
讀 .claude/plans/2026-04-29-plan-5a-handoff.md。
從 [PR 6b: response translators | PR 7: scheduler | …]
動工。工作分支 feat/plan-5a-prN-<descriptor>。
```

Then for the chosen PR:

1. Read the relevant Part's task list in `.claude/plans/2026-04-28-plan-5a-implementation.md`
2. Cross-reference `2026-04-28-plan-5a-design.md` for the design decisions
3. `git checkout main && git pull && git checkout -b feat/plan-5a-prN-<descriptor>`
4. Implement → `pnpm --filter @aide/<package> test` + `typecheck` clean
5. Commit (conventional format) → `git push -u origin <branch>`
6. `gh pr create --base main` with structured body
7. Watch CI: `gh pr checks N --watch --interval 15`
8. Wait for user `/review` → fix → merge

### Test runners
- `pnpm --filter @aide/db test` — db package vitest
- `pnpm --filter @aide/db build` — required after schema change before consuming packages typecheck
- `pnpm --filter @aide/gateway-core test` — pure unit tests
- `pnpm --filter @aide/gateway test` — gateway unit tests
- `pnpm --filter @aide/api test:integration tests/integration/migrations/` — testcontainers postgres:16-alpine
- `pnpm --filter @aide/gateway test:integration tests/workers/` — gateway worker integration

### Known fixtures + helpers
- `apps/api/tests/factories/db.ts` → `setupTestDb()` returns testDb with full migration replay
- `apps/api/tests/factories/{org,user}.ts` → `makeOrg`, `makeUser`
- `apps/gateway/tests/factories/usageLogPayload.ts` → `makeUsageLogJobPayload(overrides)` (PR #34 review fix)

---

## Recommended next PR

**PR 7 (3-layer scheduler)** is a strong candidate — pure refactor, no
forward deps, replaces the existing `failoverLoop.ts` with the sub2api
pattern.  Or **PR 6b (response translators)** if you want to finish the
translator family before moving on.  Both are zero-risk in production
(no runtime wiring beyond what already exists).

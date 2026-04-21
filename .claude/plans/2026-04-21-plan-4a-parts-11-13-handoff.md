# Plan 4A Parts 11-13 Handoff — 2026-04-21 (post PR #12)

PR #12 (Part 10 Docker + CI) merged via fast-forward. All deploy/CI infra is live on main. Parts 11-13 are docs + E2E + smoke + release — still zero net-new app code.

## Repo state

- Working dir: `/Users/hanfourhuang/ai-dev-eval`
- Main branch: `main` at `589dc5a` (Merge commit for PR #12)
- No active branch; Part 10 feature branch deleted on origin
- **Open PRs**: none
- 9 merged PRs (#4–#12, no gaps) cover Parts 1–10

**To start Part 11 (docs):**
```bash
git checkout main && git pull
git checkout -b feat/plan-4a-part-11-docs
```

(Part 11 only touches `docs/` + `apps/gateway/README.md` — no conflict surface.)

## Design + implementation plan

- **Design spec**: `.claude/plans/2026-04-20-plan4a-gateway-design.md` (1146 lines, 27-item decision log). Section 8.3 has the runbook that Task 11.1 needs to reference.
- **Implementation plan**: `.claude/plans/2026-04-20-plan-4a-gateway.md` (1841 lines, 48 tasks × 13 parts). Parts 11-13 live at lines 1734–1812.
- **Prior handoffs** (superseded):
  - `.claude/plans/2026-04-20-plan-4a-parts-7-13-handoff.md`
  - `.claude/plans/2026-04-21-plan-4a-parts-10-13-handoff.md`

## Progress: Parts 1–10 ✅, 6 tasks across 3 parts remaining

### Parts merged to main

- **PR #4** — Part 1 (6) + Part 2 (8): schema, RBAC extension, gateway-core utilities (62 tests)
- **PR #5** — Part 3 (4) + Part 4 (6): Fastify scaffold + env + apiKeyAuth + metrics + Redis layer
- **PR #6** — Part 5 (4): selectAccounts, resolveCredential, undici upstream, /v1/messages MVP
- **PR #7** — Part 6 (7): SSE parser, smart buffer, failover loop, OAuth inline refresh + cron, /v1/chat/completions, /v1/messages streaming
- **PR #8** — Part 7 infra (4 tasks): BullMQ usage-log queue + Zod payload, batched worker, inline DB fallback, hourly billing audit. 149 unit + 92 integration tests
- **PR #9** — Part 7 route wiring (4): `server.ts` lifecycle (queue/worker/audit) + non-streaming wiring + streaming SSE usage extraction on `/v1/messages`. Required a pre-merge fix (`server.test.ts` was injecting `ioredis-mock` in tests 7–8 only; tests 1, 4, 5, 6 took the production path and hit localhost:6379 in CI → fixed in `7af7a36`). 184 unit + 98 integration tests
- **PR #10** — Part 8 (4): admin tRPC routers (accounts, apiKeys, usage) + appRouter wiring. Context plumbing for `env`/`redis`/`ipAddress`/`logger` via `createContextFactory({ env, redis })`. 5 unit + 98 integration tests
- **PR #11** — Part 9 (6): `apps/web` admin UI — accounts list/create, self-issue + admin-issue API keys, reveal landing, usage dashboards. +2888/−95 across 30 files. 15 commits (6 feat + 7 review-refactor + 2 holistic polish). 99 integration tests
- **PR #12** — Part 10 (4): `Dockerfile.gateway` (multi-stage, non-root, wget healthcheck); `docker-compose.yml` (redis always up, `gateway` under `profiles: [gateway]`, `${VERSION:?}` guard on all image tags); `release.yml` matrix + `aide-gateway` multi-arch; new `gateway-integration` CI job (testcontainers postgres + redis + gateway-core). 6 commits (4 feat + 1 fix + 1 refactor). All 5 CI jobs green; local docker build + disabled-mode boot smoke passed

### Open PRs (not yet merged)

- (none)

### Parts remaining (6 tasks across 3 parts)

- **Part 11** (2) — `docs/GATEWAY.md` + `SELF_HOSTING.md` update + `apps/gateway/README.md`. **Start here next session.**
- **Part 12** (3) — Playwright E2E (happy path + admin-issued one-time URL) + `scripts/smoke-gateway.sh`
- **Part 13** (1) — v0.3.0 tag + README + CHANGELOG

## Outstanding TODOs in source (deferred from earlier parts)

Grep `TODO(part-` in `apps/gateway/src/`:

| TODO | Location | Lands in |
|---|---|---|
| `gw_*` Prometheus counters/gauges (slot, queue, idem, sticky, redis errors, oauth dead) | various | post-4A (partially covered by Part 7 billing metrics) |
| Wait queue admission control | both routes | Plan 4B/4C |
| User concurrency slot (needs `users.concurrency` schema column) | both routes | Plan 4D |
| Sticky session lookup | both routes | Plan 4B/4C |
| Idempotency cache check | both routes | Plan 4B/4C |
| `fastify-raw-body` for byte-exact upstream forwarding | messages.ts | nice-to-have |
| `/v1/chat/completions` streaming wiring (`anthropicToOpenaiStream` translator) | chatCompletions.ts | post-4A |
| `OAUTH_TOKEN_URL` env override (so route-level OAuth tests can inject fake server) | env.ts + oauthRefresh.ts | tiny follow-up |
| Account `rotate` / `edit` form UI (spec'd as stubs in Part 9; "Soon" disabled items) | `apps/web/src/components/accounts/AccountList.tsx:AccountRowActions` | post-4A (Plan 4B+) |
| Per-request detail modal on usage drill-down | `apps/web/src/components/usage/UsageTable.tsx` | post-4A |
| Team/member scope tabs on org usage page | `apps/web/src/app/dashboard/organizations/[id]/usage/page.tsx` | post-4A |

## Part 10 follow-up backlog (from PR #12 review, all deferred)

1. **`timeout-minutes` on `gateway-integration` + `integration` CI jobs**. Both inherit GitHub's 360-min default; `timeout-minutes: 15` would catch hung testcontainer starts. Not blocking Part 11; worth a tiny CI-hygiene PR later.
2. **Strip `tests/` + `vitest*.config.ts` from production images**. `Dockerfile.api` and new `Dockerfile.gateway` both ship test scaffolding in `/app` (a few MB; no load-bearing code paths). One-line fix in both Dockerfiles (`RUN rm -rf /out/tests /out/vitest*.config.ts`) in a follow-up.
3. **Stage-1 comment nit in `Dockerfile.gateway:15`** reads "transitive workspace deps" but those are actually **direct** deps from `apps/gateway/package.json`. Wording fix.
4. **Multi-arch release smoke on first `v*` tag**. All gateway runtime deps are pure-JS or have well-known prebuilt binaries (`pg`, `undici`), so `linux/amd64,linux/arm64` should work, but tag-day validation is the real proof. Add to Part 13 release checklist.

## Part 10 infrastructure (PR #12) — what's available to consume

- `docker/Dockerfile.gateway` builds `aide-gateway` image (node:20-alpine, multi-stage, non-root `aide:1001`, `EXPOSE 3002`, wget healthcheck). `pnpm deploy --prod /out` produces a self-contained bundle; sanity-require assertion catches prune misses.
- `docker/docker-compose.yml` has a new `redis:7-alpine` always-up service (`appendonly=yes`, `redis_data` volume) plus a `gateway` service under `profiles: [gateway]`. Base `docker compose up` still boots api+web+postgres+migrate+redis (no gateway). `docker compose --profile gateway up` adds it.
  - Gateway-only vars use soft defaults (`${VAR:-}`); `parseServerEnv` enforces URL + 64-char-hex shapes in the container.
  - `REDIS_URL=redis://redis:6379` baked into the gateway service (compose DNS).
  - Port `${GATEWAY_PORT:-3002}:3002` published to host; PR body flags "TLS-terminating reverse proxy in front in production".
- `.github/workflows/release.yml` matrix produces `ghcr.io/${owner}/aide-gateway:${tag}` and `:latest` multi-arch (`linux/amd64,linux/arm64`) on every `v*` tag push.
- `.github/workflows/ci.yml` has a new `gateway-integration` job (parallel to `integration`) that runs `pnpm --filter @aide/gateway test:integration` + `@aide/gateway-core test` on ubuntu-latest with Docker daemon (testcontainers).

## Part 11 brief (NEXT)

Two tasks (plan lines 1734–1751). Touches `docs/` + `apps/gateway/README.md` only.

### Task 11.1 — `docs/GATEWAY.md`
- Files: **Create** `docs/GATEWAY.md`
- Source material:
  - Design doc `.claude/plans/2026-04-20-plan4a-gateway-design.md` — architecture, RBAC matrix, Section 8.3 runbook
  - `apps/gateway/src/` — actual endpoints, metrics, env shape
  - `apps/api/src/trpc/routers/{accounts,apiKeys,usage}.ts` — admin surface
  - `apps/web/src/app/dashboard/accounts|api-keys|usage|profile` — user surface
- Sections required by spec: architecture overview; account management (add / rotate / scopes — note `rotate`/`edit` are "Soon" stubs); API key distribution (self-issue + admin-issued one-time URL); client examples (Claude Code custom base URL + OpenAI SDK pointing at our endpoint); runbook (mirror design Section 8.3); schema change policy (lifting from how migrations were staged through Parts 1–8).
- Commit: `docs: GATEWAY.md — full gateway operator + user guide`

### Task 11.2 — `SELF_HOSTING.md` update + `apps/gateway/README.md`
- Files:
  - **Modify** `docs/SELF_HOSTING.md` — add a Gateway section covering the `gateway` compose profile, `redis` service requirements, new env vars (`ENABLE_GATEWAY`, `GATEWAY_PORT`, `GATEWAY_BASE_URL`, `REDIS_URL`, `CREDENTIAL_ENCRYPTION_KEY`, `API_KEY_HASH_PEPPER`), and link to `docs/GATEWAY.md`
  - **Create** `apps/gateway/README.md` — dev startup (`pnpm -F @aide/gateway dev`), test harness (`pnpm -F @aide/gateway test` vs `test:integration`; testcontainer requirements), debug tips (pino log levels, Redis inspection, BullMQ queue stats)
- Commit: `docs: update SELF_HOSTING + add apps/gateway README`

## Part 12 brief (after 11)

Three tasks (plan lines 1755–1782). Touches `apps/web/e2e/specs/` + `scripts/`.

- **12.1** `apps/web/e2e/specs/10-gateway-happy.spec.ts` — admin creates api_key account → self-issues key → calls gateway (mocked upstream via fake-Anthropic harness, see Part 2.3) → dashboard usage row appears. Commit: `test(e2e): gateway account + self-issued key + usage visibility`.
- **12.2** `apps/web/e2e/specs/11-gateway-admin-issue.spec.ts` — admin issues key for member → URL copied → second browser context opens URL → reveal panel works → key used against gateway → IP whitelist 403 test. **This is also the Part 9 deferred E2E** the reviewer explicitly pushed to Part 12. Commit: `test(e2e): admin-issued API key one-time URL flow`.
- **12.3** `scripts/smoke-gateway.sh` — curl sequence: `/health` 200, `/metrics` 200, create account + key via api, call `/v1/messages` with seeded upstream → verify response + `usage_logs` row. Commit: `test(smoke): gateway smoke script for post-deploy verification`.

## Part 13 brief (final)

Single task (plan lines 1786–1812). **Only run after Parts 11 + 12 are all green in CI + manual smoke passes.**

- **13.1** Update `README.md` Platform mode section + create/extend `CHANGELOG.md` (`## v0.3.0 — 2026-MM-DD — Plan 4A gateway shipped`); verify full turbo green; run `scripts/smoke-gateway.sh` against staging; tag + push:
  ```bash
  git tag -a v0.3.0 -m "Plan 4A — gateway"
  git push origin v0.3.0
  ```
- `release.yml` produces `ghcr.io/hanfour/aide-{api,web,gateway}:v0.3.0` multi-arch. Manually verify: pull + boot each image on both amd64 and arm64 (addresses Part 10 follow-up #4).
- Commit: `docs: README + CHANGELOG for v0.3.0 — Plan 4A gateway`

## Learnings carried forward (updated after PR #12)

### Patterns that continue to work

1. **Subagent-driven development with two-stage review** (spec compliance → code quality) + a final holistic review at branch-end catches real bugs every PR. PR #12 used holistic-only review at branch end because tasks were small; still caught two papercuts (VERSION guard, missing gateway-core test step).
2. **Implementer reports can still miss CI-time issues.** PR #9 is the canonical example: tests passed locally because the dev had real Redis on localhost; CI caught the production-path bug. Always run the new CI job locally before pushing the PR when possible (Part 10 did this by running `pnpm -F @aide/gateway test:integration` against real testcontainers before opening PR #12).
3. **Per-part PR cadence** — Part 10 landed as ONE PR with 6 commits (4 feat + 1 fix + 1 refactor). History reads clean in `git log`.
4. **Review pushback matters.** PR #11 reviewer pushed back on deferring `listOrg userId` filter; PR #12 holistic review pushed back on missing `gateway-core test` step. Accepting the pushback in-PR costs a commit; deferring costs a future PR.
5. **Rebase-and-test-fix-first beats close-and-restart** for stale PRs. PR #9 was stale on 04-20 with a CI failure; 1 rebase + 1 tiny fix → merged same day. Closing would have thrown away all the review history.

### Newly proven patterns (Part 10)

- **`pnpm deploy --prod` only hoists direct deps**. Transitive runtime deps (e.g. `pg` reached via `@aide/db`) live in `/out/node_modules/.pnpm/*` and resolve via nested `node_modules` lookup — they do NOT appear in `/out/node_modules/<name>` top-level. Sanity-require lists must match `package.json.dependencies` exactly, not "every module imported anywhere in the tree".
- **Compose interpolates inactive-profile service env vars at config time.** `${VAR:?required}` in a profile-gated service's env block fails the base `docker compose config` / `up` even when the profile isn't active. Use soft defaults (`${VAR:-}`) and move validation into the container's startup code (`parseServerEnv`).
- **Redis "always up" + service behind profile** is a clean pattern. Keeps future cache consumers (sticky sessions, idempotency) from needing a second compose change. No cost if unused.
- **Mirror the existing Dockerfile shape religiously.** Deviations should be explicit and documented. The only divergence between `Dockerfile.api` and `Dockerfile.gateway` is the workspace package set copied (no `@aide/auth`/`@aide/api-types`) and the sanity-require list — every other choice (alpine, corepack, cache mount, `aide:1001` user, wget healthcheck, `start-period=15s`) is identical.
- **Multi-arch matrix is cheap to extend.** Adding `gateway` to `release.yml` matrix was a 1-line change; multi-arch setup (qemu + buildx) was already done in PR #3.
- **Compose config smoke before commit.** `docker compose --env-file <fake-vals> -f … --profile gateway config` runs in ~1s and catches env-interpolation bugs that `docker compose up` would only surface after the postgres container starts. Use it.

### Bug categories that surfaced in PR #12 (and fixes applied)

| Class | Example | Fix pattern |
|---|---|---|
| Sanity-require lists transitive deps | `require('pg')` fails at `/out` root | Drop to direct-deps-only; document why |
| Env var `:?required` on profile-gated service | `${CREDENTIAL_ENCRYPTION_KEY:?}` breaks base compose | Use soft defaults; validate at container boot via `parseServerEnv` |
| Spec line not reflected in implementation | `pnpm -F @aide/gateway-core test` missing from new CI job | Add as explicit step even if currently redundant (future-proofs integration-suite home) |
| Image tag without `:?` guard | `${VERSION}` silent-empty on missing export | `${VERSION:?VERSION is required}` consistent across every service |

## Suggested resume command for next session

```
繼續 Plan 4A。讀 .claude/plans/2026-04-21-plan-4a-parts-11-13-handoff.md
1. git checkout main && git pull
2. git checkout -b feat/plan-4a-part-11-docs
3. 從 Task 11.1 (docs/GATEWAY.md) 開始
4. 繼續 subagent-driven 模式（implementer → spec reviewer → code quality reviewer → holistic reviewer on branch end）
```

## Checks to run at Part boundaries

```bash
pnpm turbo run lint typecheck test \
  --filter=@aide/db --filter=@aide/auth --filter=@aide/gateway-core \
  --filter=@aide/gateway --filter=@aide/api --filter=@aide/config --filter=@aide/web

# Integration tests (need Docker for testcontainers)
pnpm -F @aide/gateway test:integration
pnpm -F @aide/api test:integration

# E2E (Part 12 will add gateway specs; Part 11 doesn't touch E2E)
pnpm -F @aide/web e2e
```

For Part 11 specifically, the above is overkill — docs changes don't need the test suite. Minimum gate:
```bash
# Markdown lint (if markdownlint is configured) or eyeball the rendered files
# Confirm every cross-reference path exists:
grep -oE '\`[a-zA-Z./_-]+\`' docs/GATEWAY.md | tr -d '\`' | xargs -I{} test -e {} && echo "all paths ok"
```

## Post-4A parking lot (won't be in v0.3.0)

Pulled from Part 9/10 review feedback + Parts 4-8 deferrals. Capture so they don't get lost.

- `StatusBadge` unify across `accounts/status.tsx` + `ApiKeyList.tsx` + `UsageTable.tsx` (different `/10` vs `/15` dark-mode opacity tokens)
- Account `update` / `rotate` admin forms (stubbed as "Soon" in Part 9)
- Per-request usage detail modal
- Team/member scope tabs on org usage page (needs `summaryByUser` tRPC variant first)
- `superjson` transformer on the tRPC client — would let `inferRouterOutputs` return `Date` instead of `string` for timestamp columns. Currently handled in `@/lib/time` and each helper's signature accepts `Date | string | null`.
- Audit other root `@aide/auth` imports in `apps/web` for subpath migration opportunities
- pg client teardown race in `apps/api` integration tests (CI-only flake on PR #11; re-run passed)
- `timeout-minutes` on `integration` + `gateway-integration` CI jobs
- Strip `tests/` + `vitest*.config.ts` from `Dockerfile.api` and `Dockerfile.gateway` production images
- Dockerfile.gateway stage-1 comment nit ("transitive" → "direct")

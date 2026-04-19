# Plan 3 Handoff — 2026-04-19

Session ended intentionally before Task 11 to keep context fresh. Resume here.

## Repo state
- Working dir: `/Users/hanfourhuang/ai-dev-eval`
- Branch: `feat/ui-docker-e2e` (latest commit `3236dc2`, ahead of `origin/feat/ui-docker-e2e` by 1 commit — push or leave local per preference)
- Main: `main`
- Plan: `.claude/plans/2026-04-18-plan-3-ui-docker-e2e.md`

## Progress: 10 / 25 tasks

### Completed
| Task | What | Commit |
|------|------|--------|
| 1-5 | Apple-style dashboard, sidebar, topbar, orgs, teams, departments | `0f3d971` → `b906651` |
| 6 | Members / Invites / Audit / Profile / Invite-accept pages | `e3294e2` |
| 7 | sign-in error messages (AccessDenied / OAuthAccountNotLinked / …) | `3236dc2` |
| 8 | `not-found.tsx` + `error.tsx` + `global-error.tsx` + `dashboard/error.tsx` | `3236dc2` |
| 9 | `usePermissions` hook + `RequirePerm` guard | `3236dc2` |
| 10 | `/test-seed` REST endpoint (triple-layer gating) + `ENABLE_TEST_SEED` env | `3236dc2` |

### Remaining
- **11** Dockerfile.api (multi-stage, pnpm deploy to /out)
- **12** Dockerfile.web (Next.js standalone)
- **13** Production docker-compose.yml with migrate step
- **14** release.yml GitHub Action → ghcr.io
- **15** SELF_HOSTING.md
- **16** Real /health + /health/ready probes (currently stub)
- **17** Playwright install + config + mock-oauth + seed-db helpers
- **18-22** 5 Playwright E2E specs (sign-in, invite+accept, team CRUD, RBAC rejection, audit)
- **23** CI e2e job
- **24** Full DoD verification
- **25** Tag v0.2.0 + README update

## Open concerns to decide later
- `me.updateProfile` returns full users row but session only exposes id/email → profile form can't prefill name/image. Low-pri.
- `auditLogs.id` is bigint; audit page uses `String(l.id)` as workaround for no superjson transformer.
- `invite/[token]` auto-accept uses state flag; consider useRef for StrictMode double-invoke.

## Checks that should stay green between tasks
```
pnpm -F @aide/api typecheck
pnpm -F @aide/web typecheck
pnpm -F @aide/web build
pnpm -F @aide/api test
pnpm -F @aide/config test
pnpm -F @aide/auth test
```

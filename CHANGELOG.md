# Changelog

All notable changes to aide are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Platform mode
releases are tagged `vX.Y.Z`; each tag publishes multi-arch images to
`ghcr.io/hanfour/aide-{api,web,gateway}`.

## v0.4.0 — 2026-04-22 — Plan 4B evaluator shipped

Evaluation subsystem: opt-in content capture, rule-based + LLM scoring, 
admin-customizable rubrics, GDPR workflow, labor-law-friendly transparency.

**14 design decisions** (from `.claude/plans/2026-04-22-plan-4b-evaluator-design.md`):

1. Opt-in per-org content capture (`organizations.content_capture_enabled`); 
   members transparent via `/dashboard/profile/evaluation`.
2. AES-256-GCM body encryption using `CREDENTIAL_ENCRYPTION_KEY` with 
   domain-separated HKDF info (`aide-gateway-body-v1`); 90-day default 
   retention with per-org override (30/60/90).
3. Dual-layer evaluation: rule-based scoring always-on, LLM Deep Analysis 
   opt-in per org.
4. LLM calls dogfooded via self-gateway loopback; cost attribution lands in 
   `usage_logs` under a dedicated system-user `api_key`.
5. Rubric-driven scoring engine with Zod-validated 9-type signal discriminated 
   union (keyword, threshold, refusal_rate, client_mix, model_diversity, 
   cache_read_ratio, extended_thinking_used, tool_diversity, iteration_count).
6. Platform-default rubrics seeded for en/zh-Hant/ja; org-custom rubrics 
   validated client-side + server-side.
7. Upsert-on-rerun semantics for `evaluation_reports` (unique on 
   user+period+type).
8. Four-layer `ENABLE_EVALUATOR` feature gate: env → router procedure → UI 
   route → orchestration cron.
9. LLM Deep Analysis gated on `data_quality.coverageRatio ≥ 0.5` to avoid 
   wasted cost on low-signal windows.
10. GDPR delete as a request/approval workflow (not auto-execute); 30-day SLA 
    triggers auto-reject.
11. Retention purge cron (4h cadence) + GDPR execution cron (5min cadence) 
    separate from main request path.
12. LLM narrative redaction: members always see own full report; team_managers 
    see team reports with LLM fields nulled unless they are also org_admin.
13. Leaderboard visibility is opt-in per org (`leaderboardEnabled`) — privacy 
    default.
14. Body truncation with flipped priority (preserve `attempt_errors` — dropped 
    last) to retain failover debugging context.

### Added

- `@aide/evaluator` workspace package (pure-logic scoring engine + LLM prompt 
  builder)
- Org settings: `/dashboard/organizations/[id]/evaluator/settings`
- Rubric management: `/dashboard/organizations/[id]/evaluator/rubrics` (with 
  dry-run preview)
- Evaluator status: `/dashboard/organizations/[id]/evaluator/status`
- Member detail with 30-day trend + evidence drill-down: 
  `/dashboard/organizations/[id]/members/[uid]`
- Team evaluator aggregate + optional leaderboard: 
  `/dashboard/organizations/[id]/teams/[tid]`
- Org members table latest-score column
- Member self-view: `/dashboard/profile/evaluation`
- GDPR export + deletion request dialogs
- Migration 0002 (4 new tables + 10 `organizations` columns) + 0003 (seed 3 
  platform rubrics)
- BullMQ workers: body capture, evaluator, retention purge, GDPR delete, GDPR 
  auto-reject
- tRPC routers: `contentCapture`, `rubrics`, `reports`, `evaluator` — all 
  gated by `ENABLE_EVALUATOR`
- CI job `evaluator-integration` + Playwright E2E spec + smoke script

### Changed

- `gateway-core` exposes `encryptBody`/`decryptBody` alongside existing 
  `encryptCredential`/`decryptCredential` (refactored to share AES-GCM+HKDF 
  primitive).
- `apiKeyAuth` middleware populates `req.gwOrg.contentCaptureEnabled` + 
  `retentionDaysOverride`.
- Fastify decorators add `bodyCaptureQueue` + `evaluatorQueue` alongside 
  existing `usageLogQueue`.
- RBAC `Action` union extended with 14 new evaluator-scoped actions.

### Docs

- `docs/EVALUATOR.md` — subsystem overview, runbook, env vars, metrics
- `docs/runbooks/evaluator-rollout.md` — 5-step live-deployment playbook
- `docs/GATEWAY.md` — new "Body Capture" section
- `docs/SELF_HOSTING.md` — "Enable the evaluator" section

## v0.3.0 — 2026-04-22 — Plan 4A gateway shipped

### Added

- **Gateway data plane** (`apps/gateway`, port `3002`, opt-in behind the
  `gateway` compose profile + `ENABLE_GATEWAY=true`). Proxies Anthropic
  traffic through a shared pool of upstream accounts.
  - `POST /v1/messages` — Anthropic-native, streaming + non-streaming
  - `POST /v1/chat/completions` — OpenAI-compatible, non-streaming in 4A
  - `GET /health`, `GET /metrics` (Prometheus)
- **Upstream account pool** — admins add `sk-ant-...` API keys or OAuth
  bundles scoped to an org or a specific team; per-account priority,
  concurrency, rate-limit state, and error tracking.
- **Platform API keys** (`ak_...`) — self-issue from `/dashboard/profile`
  or admin-issue for another member via a one-time reveal URL.
  HMAC-SHA256-hashed with a server-side pepper; never stored or logged in
  plaintext.
- **Credential vault** — AES-256-GCM with HKDF-derived per-account
  sub-keys. Master key injected via secret mount only.
- **Failover** — per-request scheduler tries up to
  `GATEWAY_MAX_ACCOUNT_SWITCHES` accounts, classifies upstream errors,
  parks rate-limited / overloaded / decrypt-failed accounts.
- **Smart buffering** — first ~500 ms / ~2 KB of a streaming response is
  buffered so an upstream 5xx mid-connect becomes a clean 5xx client-side.
- **Inline OAuth refresh + cron** — proactive pre-expiry refresh with a
  per-account Redis lock.
- **Usage pipeline** — BullMQ-queued inserts into `usage_logs` with inline
  fallback if the queue is down. Hourly Bernoulli-sampled billing audit
  counts drift between `SUM(usage_logs.total_cost)` and
  `api_keys.quota_used_usd`.
- **Admin tRPC routers** — `accounts.*`, `apiKeys.*`, `usage.*` + new RBAC
  actions (`account.*`, `api_key.*`, `usage.*`).
- **Admin UI** — org accounts list / create
  (`/dashboard/organizations/[id]/accounts`), self-service keys on
  `/dashboard/profile`, admin-issued keys on
  `/dashboard/organizations/[id]/members/[uid]/api-keys`, one-time reveal
  at `/api-keys/reveal/[token]`, org and per-user usage dashboards.
- **Docs** — new `docs/GATEWAY.md` (architecture, client examples, 7-item
  runbook, schema-change policy) + `apps/gateway/README.md`.
  `docs/SELF_HOSTING.md` gains a Gateway § (compose profile, new env vars,
  TLS + secret posture).
- **Infra** — `docker/Dockerfile.gateway` (multi-stage, non-root,
  wget healthcheck), `redis:7-alpine` always-up in compose, new
  `gateway-integration` CI job (testcontainers postgres + redis), new
  `gateway` matrix in `release.yml` for multi-arch images.
- **Playwright E2E** — gateway happy-path + admin-issued one-time URL
  specs (`apps/web/e2e/specs/10-gateway-happy.spec.ts`,
  `11-gateway-admin-issue.spec.ts`) with a stdlib fake Anthropic upstream
  (`apps/web/e2e/fixtures/run-fake-anthropic.mjs`).
- **Post-deploy smoke** — `scripts/smoke-gateway.sh` verifies `/health`,
  `/metrics`, `POST /v1/messages`, and (optionally) a `usage_logs` row.

### Changed

- `packages/config/src/env.ts` — 17 new gateway env vars. Required when
  `ENABLE_GATEWAY=true`: `GATEWAY_BASE_URL`, `REDIS_URL`,
  `CREDENTIAL_ENCRYPTION_KEY` (32 bytes hex), `API_KEY_HASH_PEPPER`
  (32 bytes hex).
- `apps/api` admin routers throw `NOT_FOUND` when the gateway flag is off
  (defense-in-depth; the UI also hides the nav).
- `accounts.create` / `accounts.rotate` now wrap the UI-supplied
  credential in the `{type, api_key | access_token, ...}` envelope the
  gateway expects, instead of encrypting the raw string.

### Notes

- **Schema change policy** (enforced from v0.3.0 onwards): additive only
  (new tables, nullable columns, indexes, `NOT VALID` CHECKs). No enum
  value additions to existing enums, no nullability/type changes. See
  `docs/GATEWAY.md#9-schema-change-policy`.
- **Deferred to post-4A** — streaming for `/v1/chat/completions`,
  wait-queue admission control, sticky sessions, idempotent `X-Request-Id`
  replay, account rotate/edit UI forms, per-request usage detail modal,
  per-team usage drill-down, IP-allowlist UI, scripted credential-key
  rotation.

## v0.2.0 — Platform mode launched

Self-hostable web platform: Next.js UI + Fastify API, OAuth sign-in,
org-scoped RBAC, invites, audit log. First images published to
`ghcr.io/hanfour/aide-{api,web}`.

## v0.1.0 — CLI initial release

AI Development Performance Evaluator — reads local Claude Code /
Codex usage data and produces evaluation reports. Terminal / JSON /
Markdown / HTML output.

# Plan 4C Handoff — 2026-04-24

Plan 4B (evaluator, v0.4.0) shipped. Use this doc to seed the Plan 4C brainstorming session.

## Repo state

- Working dir: `/Users/hanfourhuang/ai-dev-eval`
- Main branch: `main` at `d9e02d3` (Plan 4B merged as squash `807d85e` + Dockerfile fix)
- Latest tag: `v0.4.0` (released 2026-04-24T08:56:00Z)
- Docker images published: `ghcr.io/hanfour/aide-{api,web,gateway}:v0.4.0`
- Migration set: 0000, 0001 (Plan 4A), 0002 (Plan 4B schema), 0003 (Plan 4B rubric seed)
- Feature flag: `ENABLE_EVALUATOR=false` by default; 4-layer gate (env → tRPC procedure → UI route → server bootstrap)

## Plan 4B summary — what shipped

**Tables:** rubrics, request_bodies, evaluation_reports, gdpr_delete_requests (+ 10 `organizations` columns)

**Pipelines:**
- Body capture: opt-in per-org, AES-256-GCM + HKDF domain `aide-gateway-body-v1`, 90-day default retention, 4h purge cron
- Evaluator: daily 00:05 UTC cron enqueues jobs per active member; rule-based scoring via `@aide/evaluator` + optional LLM Deep Analysis via self-gateway loopback
- GDPR: member-initiated delete request, admin approve/reject, 5-min executor cron, 30-day SLA auto-reject

**Rubrics:** 3 platform defaults seeded (en/zh-Hant/ja). CLI `templates/eval-standard.json` ported with the following mapping decisions (signed off at impl time):
- `iterativeRatio` → `iteration_count >= 3`
- `bugsCaught` / `frictionSessions` / `codexErrorSessions` → dropped at rule level; LLM Deep Analysis `sectionAdjustments` covers them
- `frictionSessions` → `refusal_rate <= 0.2` (loose mapping)
- Weights normalized 40/60 (CLI had 20/50 = 70% total)

**RBAC:** 14 new actions for content_capture / rubric / report / evaluator

**UI:**
- Admin: settings, rubric CRUD + dry-run, status, member detail + 30-day trend + evidence drill-down, team aggregate + opt-in leaderboard, org list latest-score column
- Member: profile evaluation page, export dialog, GDPR delete request dialog, capture-enabled banner (driven by `me.captureDisclosure`)

## Follow-ups closed during 4B final sprint

These 4 deferred items from the original 4B plan were completed before v0.4.0 tag:

- **Task 3.5b** — streaming transcript assembly (StreamTranscript accumulator in `streamUsageExtractor`)
- **Task 5.4 skipped tests** — `fetch_error` / `fetch_non_2xx` / `parse_error` now tested via `mkDbReturning` chainable mock
- **Task 6.4b** — evaluator BullMQ queue wired into apps/api tRPC context (`ctx.evaluatorQueue`)
- **`me.captureDisclosure`** — dedicated tRPC endpoint; ProfileBanner no longer uses report-existence proxy

## Known technical debt / paper cuts

1. **SettingsForm lost its client-side Zod resolver** (CI round 9) — form-level validation removed to unblock e2e; server zod is authoritative. A proper fix would re-add a resolver that correctly handles React native-select quirks (`Number("") === 0`, empty string round-trips).

2. **tRPC onError logger is permanent** — added for CI diagnostics in round 10, still in place. Arguably useful for prod but leaks input shape at warn level. Consider gating on `env.LOG_LEVEL === 'debug'`.

3. **Release workflow QEMU arm64 build time** — v0.4.0 first attempt stalled for 65+ min on web arm64 build before we cancelled + retried. Retry succeeded in ~20 min. Appears runner-environment flaky, not code. Consider: native arm64 runner, or drop arm64 from web (amd64 covers most deployments).

4. **Gateway e2e test artifact upload path** was wrong in ci.yml (`apps/web/playwright-report/` → `apps/web/e2e/playwright-report/`). Fixed during the CI iteration.

5. **Integration test for streaming transcript assembly** — 8 unit tests cover the accumulator, but no end-to-end SSE round-trip test exists. Would catch real Anthropic event format drift.

6. **`evaluatorQueue` in api ctx uses dedicated Redis connection** — no connection pooling across the api pipeline. Should consolidate into `app.redis` reuse like gateway does.

7. **Platform rubric weights 40/60 normalize CLI's 20/50** — decision was to scale up proportionally (CLI weights only summed to 70%, implying a dropped third section). If/when a third section is added, re-tune.

8. **`noiseFilters` flattened to a single string array** — CLI had `{prefixes, templatePhrases, minLength}`. Gateway schema only has flat array, so `minLength` was dropped. If this becomes useful later, extend the schema.

## Open gaps (things deferred entirely to future plans)

These appeared in 4B design discussion but were explicitly scoped out:

- **Email integration** (Plan 4D per design §8.2) — GDPR request/approval notifications go to audit_logs only. Members + admins get no outbound email.
- **LLM facet extraction** — `bugsCaught` / `frictionSessions` / `codexErrorSessions` dropped because gateway has no LLM-analyzed facets. CLI has them via pre-analyzed ClaudeCodeFacet. A future plan could add an LLM facet extraction step to the evaluator worker.
- **Cost budget + alert** — LLM Deep Analysis has no per-org monthly cap. If an org misconfigures llmEvalModel to claude-opus, spend can drift.
- **Rubric marketplace / sharing** — each org creates their own. No pattern for sharing customizations.
- **Per-section LLM commentary** — current narrative is whole-report. Splitting per-section would enable finer UI.
- **Export format variety** — JSON only. CSV / PDF would help non-technical members.
- **Evaluation diff view** — no "before/after" comparison when a rubric changes.

## Candidate Plan 4C themes

These are the natural next-plan scopes. User picks one (or two compatible):

### Theme A — Operations hardening (conservative)
Focus: make 4B robust in production
- Grafana dashboards for every `gw_body_*` / `gw_eval_*` / `gw_gdpr_*` metric
- Alert runbooks for DLQ, purge lag, GDPR SLA violations
- Per-org LLM cost budget + alert (Slack/webhook)
- Automated staging smoke test workflow (GitHub Actions runs `scripts/smoke-evaluator.sh` after each release)
- Native arm64 runner for Docker release workflow
- Integration test for SSE → transcript assembly end-to-end

### Theme B — LLM facet enrichment (recovers CLI parity)
Focus: close the gap where 4B dropped CLI-parity signals
- Add a facet-extraction step to evaluator worker (before `scoreWithRules`)
- Prompt Claude to produce `{sessionType, outcome, claudeHelpfulness, frictionCounts}` per session
- Persist facets to a new `request_body_facets` table (same lifecycle as bodies)
- Extend signal schema with `facet_*` types (`facet_iterative_sessions`, `facet_bugs_caught`, `facet_friction_sessions`)
- Update platform-default rubric to use these when available, fall back to gateway-native signals when not

### Theme C — Member transparency + engagement
Focus: improve the member-facing UX
- Weekly/monthly digest email ("Your evaluation for <period>")
- Per-section LLM commentary (split narrative into 2-3 section-level paragraphs)
- Evaluation trend insights ("Your refusal rate dropped 40% this week")
- CSV + PDF export formats
- In-app notification badge when new report is available
- Depends on Plan 4D email integration being started

### Theme D — Rubric governance
Focus: multi-org rubric management
- Rubric marketplace (platform-wide discovery of published rubrics)
- Fork-and-customize workflow (org copies another org's public rubric)
- Rubric versioning with changelog
- Dry-run diff view (compare two rubrics' scores on the same period)
- Rubric A/B testing (run two rubrics in parallel, compare outputs)

### Theme E — Analytics & aggregates
Focus: dashboard-level views
- Org-wide trend charts (average score over 90 days)
- Team comparison views
- Leaderboard privacy modes (anonymized rank, opt-out)
- Percentile / distribution views
- ClickHouse integration for scale

## Pre-brainstorm questions for the user

Before writing the Plan 4C design spec, answer these:

1. **Which theme (or combination)?** My bias: **A + B** for v0.5.0 — A de-risks 4B in prod, B recovers the dropped signals. C/D/E are better in v0.6.0+ once 4B has real production telemetry.

2. **Plan 4D (email integration) timing** — does it block Plan 4C Theme C, or can C land stub-digests that ship later when email works? If blocking, probably do email + digest in 4D first.

3. **Deployment cadence** — is Plan 4B going to bake in staging for a week before prod, or deploy on merge? Answer affects priority of Theme A items (full observability only worth it if there IS real traffic).

4. **LLM facet extraction cost** — Theme B adds a second LLM call per evaluation window. For a 100-user org, daily × 100 × $0.03/call = $90/day. Budget acceptable? Only worth doing if org enables `llm_eval_enabled`.

5. **Rubric marketplace trust model** (Theme D) — who vets shared rubrics? Super-admin? Opt-in per-org allowlist? Open?

6. **Any hard deadlines?** — e.g., "v0.5.0 must ship by YYYY-MM-DD because ..."

## Reference files

- `.claude/plans/2026-04-22-plan-4b-evaluator-design.md` (891-line design with 14-item decision log)
- `.claude/plans/2026-04-22-plan-4b-evaluator.md` (1157-line implementation plan, 55 tasks × 14 parts)
- `.claude/plans/2026-04-22-plan-4b-handoff.md` (pre-Plan-4B handoff, has 6 pre-impl review items)
- `docs/EVALUATOR.md` (user-facing subsystem docs)
- `docs/runbooks/evaluator-rollout.md` (5-step rollout playbook)
- `templates/eval-standard.json` (CLI's original 2-section rubric, source of 4B's platform defaults)

## Suggested resume prompt for next session

```
讀 .claude/plans/2026-04-24-plan-4c-handoff.md
挑 Plan 4C theme 後開始 brainstorm + 寫 design spec。
我傾向 Theme A + B（v0.5.0）。先回答 6 個 pre-brainstorm 問題。
```

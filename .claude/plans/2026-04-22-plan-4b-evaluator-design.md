# Plan 4B — Evaluator Design

**Status:** Brainstorm complete (2026-04-22), pending user review of written spec
**Target release:** v0.4.0
**Predecessor:** Plan 4A (v0.3.0 — gateway data plane)
**Successors:** Plan 4C (multi-provider + account pool) · Plan 4D (credit / quota + admin tooling)

---

## Goal

Close the loop that Plan 4A opened: now that every API request flows through `apps/gateway` and lands in `usage_logs`, turn those records plus opt-in captured request/response bodies into **per-member evaluation reports** that engineering managers can review on the dashboard. Match the qualitative depth of aide's existing CLI rubric (`templates/eval-standard.json`) while respecting labor-law transparency and data-minimization norms.

## Architecture bar

- Never requires the member to run a local tool or upload anything — the data is already in the platform via Plan 4A's gateway.
- Opt-in content capture at the **org** level with explicit member visibility (no secret surveillance).
- Default engine is **rule-based** (deterministic, zero extra cost, data stays in DB). Optional LLM Deep Analysis dogfoods the org's own upstream account.
- All captured bodies encrypted at rest (AES-256-GCM, HKDF-derived sub-key per request) and subject to 90-day retention; reports are aggregate/scored artifacts and retained perpetually.
- Members see their own full reports (GDPR, Mitbestimmung, Taiwan 個資法 compliance); admins see their scope; super_admin sees only aggregate metadata.

## Non-goals (out of 4B)

- Multi-provider evaluation (OpenAI / Gemini) — the rubric is Claude-centric in 4B; expansion in Plan 4C
- Cross-team / cross-org leaderboards — political hot-button, deferred
- Real-time per-request scoring — batch daily, with manual rerun on demand
- Per-stream-chunk timing / event log capture — too expensive vs. marginal signal; defer to 4C
- Raw image bytes retention — 4B stores only `{mime, size, sha256}` metadata
- Separate eval CLI (`aide eval` on gateway) — existing CLI continues to serve the `~/.claude/` local-data path; 4B is the platform-side twin
- S3 body store implementation — interface + stub present; only Postgres backend implemented in 4B
- External alerting pipeline for evaluator failures — metrics emitted, but wiring to Alertmanager is Plan 4D admin tooling

---

## Section 1 — Architecture Overview

### Deployment topology (what changes from v0.3.0)

```
apps/web   :3000  ── (UI: member reports + admin evaluator settings)
apps/api   :3001  ── (new tRPC routers: evaluator, reports, rubrics; admin CRUD for capture toggle)
apps/gateway :3002 ── (NEW body-capture branch after Step 10 when org has contentCaptureEnabled)
                     (NEW evaluator cron worker — runs daily, one-shot per period)
                     (NEW: calls self via its own /v1/messages when LLM Deep Analysis is enabled)

Postgres            — existing +3 tables (request_bodies, evaluation_reports, rubrics), 1 soft-delete queue
Redis               — existing + 1 BullMQ queue: aide:gw:evaluator
Body store          — BodyStore interface; PostgresBodyStore ships in 4B; S3BodyStore stub for 4C
```

### New package

- **`packages/evaluator`** — pure-logic package (no Fastify, no DB driver directly) containing:
  - Rubric schema validator (Zod) and rubric loader (reads the same `templates/eval-standard.json` shape as CLI, adapts signal inputs to gateway data)
  - Rule-based scoring engine: signal collectors + threshold matchers + evidence extractors
  - LLM prompt builder for Deep Analysis (constructs the evaluator prompt with rubric + captured snippets)
  - Report composition helpers

Mirrors the `@aide/gateway-core` shape from Plan 4A: zero external service dependencies, extensively unit-testable with fixture pairs.

### Existing packages extended

- `@aide/db` — 3 new tables + 1 new column group on `organizations`
- `@aide/auth` — 8 new RBAC action types (`content_capture.*`, `evaluator.*`, `report.*`, `rubric.*`)
- `@aide/config` — 4 new env vars
- `apps/api` — 4 new tRPC routers (`contentCapture`, `reports`, `rubrics`, `evaluator`)
- `apps/gateway` — body capture branch in request pipeline, evaluator cron worker, optional LLM-eval BullMQ consumer
- `apps/web` — 4 new dashboard routes, new "Evaluation" section on `/profile`, and admin settings pane

### Route boundaries

- **`apps/api` (admin plane):**
  - `contentCapture.*` — org_admin opt-in toggle, retention override, LLM account binding
  - `rubrics.*` — list / create org-custom rubric (validates against Zod schema, stores in new `rubrics` table)
  - `reports.*` — read reports (scoped per the access model in §6), trigger manual rerun, GDPR export / delete
  - `evaluator.*` — read-only status (last cron run, next run time, queue depth)
- **`apps/gateway` (data plane):**
  - Request pipeline: after Step 10 (usage log enqueue), add Step 10a — body capture enqueue (separate queue) if org has `contentCaptureEnabled`
  - `/v1/*` routes unchanged from 4A; body capture is non-blocking side-effect
- **`apps/web`:** new admin routes under `/dashboard/organizations/[id]/evaluator/*`; member-facing routes under `/dashboard/profile/evaluation/*`

### Tech choices

| Concern | Choice | Rationale |
|---|---|---|
| Body compression | gzip | Node stdlib, ~3× size reduction on prompt text |
| Body encryption | AES-256-GCM + HKDF-SHA256 (reuse `@aide/gateway-core` cipher) | Same master key / domain separation via `info` |
| Body store backend | Postgres bytea (default) · S3-compat stub | Self-host simplicity; S3 adapter stub in 4B, impl in 4C |
| Evaluator queue | BullMQ on shared Redis | Already in place from Plan 4A |
| Rubric persistence | JSONB in `rubrics` table | Matches existing CLI JSON schema, org-customizable |
| Rule engine | Pure TS (functional) | Auditable, deterministic, vitest-friendly |
| LLM engine | Anthropic via the org's own upstream account, routed through our own gateway | Dogfood + explicit cost attribution in `usage_logs` |

### Deployment artifacts

- No new Docker image (evaluator cron runs inside `apps/gateway`)
- No new compose service
- `release.yml` unchanged
- `ci.yml` adds `evaluator-integration` job (testcontainers Postgres + Redis)

---

## Section 2 — Data Model

Three new tables (`request_bodies`, `evaluation_reports`, `rubrics`), one column group added to `organizations`, plus a soft-delete queue for GDPR.

### 2.1 `organizations` — content capture columns

Extend existing table; all fields default to "off":

```
content_capture_enabled        boolean NOT NULL default false
content_capture_enabled_at     timestamptz
content_capture_enabled_by     uuid references users.id
retention_days_override        int             -- NULL = use default 90d
llm_eval_enabled               boolean NOT NULL default false
llm_eval_account_id            uuid references upstream_accounts.id
llm_eval_model                 text            -- default 'claude-3-5-sonnet-20241022'
capture_thinking               boolean NOT NULL default false  -- extended thinking opt-in
rubric_id                      uuid references rubrics.id      -- NULL = platform default
leaderboard_enabled            boolean NOT NULL default false  -- team-internal ranking
```

Single migration, all nullable or default-false. Safe additive rollout.

### 2.2 `request_bodies` (encrypted, 90-day retention by default)

```
request_id                    text PK, FK → usage_logs.request_id
org_id                        uuid NOT NULL FK → organizations.id
request_body_sealed           bytea           -- nonce(12) || ciphertext || authTag(16)
response_body_sealed          bytea
thinking_body_sealed          bytea           -- NULL unless org.capture_thinking
attempt_errors_sealed         bytea           -- JSON-encoded error chain (encrypted)
-- Cleartext metadata (non-content, used for WHERE filters)
request_params                jsonb           -- {temperature, top_p, max_tokens, stop_sequences, tool_choice, thinking.budget_tokens}
stop_reason                   text            -- end_turn | max_tokens | tool_use | stop_sequence | refusal
client_user_agent             text
client_session_id             text
attachments_meta              jsonb           -- [{mimeType, sizeBytes, sha256}]
cache_control_markers         jsonb           -- [{index, type, ttl}]
tool_result_truncated         boolean NOT NULL default false
body_truncated                boolean NOT NULL default false
captured_at                   timestamptz NOT NULL default now()
retention_until               timestamptz NOT NULL    -- now() + org.retention_days_override || 90 days
```

**Indexes:**
- `(retention_until)` — `WHERE retention_until <= now()` for purge cron
- `(org_id, captured_at)` — evaluator cron window fetch
- `(request_id)` — already PK

**Sanitization at capture time** (before encryption):
- `request_params` and `tool_use.input` JSON walked; any key matching `/password|secret|token|api_key|bearer|cookie|authorization/i` → value replaced with `"***"`
- Per-`tool_result` size cap: content >16KB truncated to `{head: first 4KB, tail: last 4KB, fullSize, fullSha256}`
- Overall body post-compression size cap: 256KB → set `body_truncated = true`, drop in priority order: `attempt_errors` > `thinking_body` > `tool_result.content[].tail` > `response_body` tail

### 2.3 `rubrics` (org-customizable scoring definitions)

```
id                uuid PK
org_id            uuid FK → organizations.id (NULL for platform-default rubrics)
name              text NOT NULL
description       text
version           text NOT NULL              -- semver of the rubric ("1.0.0")
definition        jsonb NOT NULL              -- same shape as templates/eval-standard.json
is_default        boolean NOT NULL default false  -- platform default (one row per locale)
created_by        uuid FK → users.id
created_at, updated_at, deleted_at
```

**Rubric definition shape** (extends CLI's `EvalStandard` interface; see §5 for full schema):

```jsonc
{
  "name": "aide default — gateway platform",
  "description": "Evaluation rubric adapted from CLI for gateway-captured traffic",
  "sections": [
    {
      "id": "interaction",
      "name": "AI Interaction & Decision / AI 交互與決策",
      "weight": "20%",
      "standard": { "score": 100, "label": "Standard", "criteria": [...] },
      "superior": { "score": 120, "label": "Superior", "criteria": [...] },
      "keywords": ["option", "alternative", "compare", "approach", ...],
      "thresholds": { "iterationCount": 5, ... },
      // NEW for 4B (gateway-specific signals):
      "signals": [
        { "type": "keyword", "in": "request_body", "terms": [...] },
        { "type": "threshold", "metric": "cache_read_ratio", "gte": 0.2 },
        { "type": "threshold", "metric": "model_diversity", "gte": 2 },
        { "type": "refusal_rate", "lte": 0.05 },
        { "type": "client_mix", "expect": ["claude-code"], "minRatio": 0.5 }
      ]
    }
  ]
}
```

**Indexes:**
- `(org_id) WHERE deleted_at IS NULL`
- `(is_default) WHERE is_default = true`  — platform default lookup

### 2.4 `evaluation_reports` (append-plus-upsert, perpetual retention)

```
id                    uuid PK (uuidv7)
org_id                uuid NOT NULL FK
user_id               uuid NOT NULL FK                 -- evaluee
team_id               uuid FK                          -- snapshot of team at eval time
period_start          timestamptz NOT NULL
period_end            timestamptz NOT NULL
period_type           text NOT NULL                    -- daily | weekly | monthly | adhoc
rubric_id             uuid NOT NULL FK → rubrics.id
rubric_version        text NOT NULL                    -- snapshot for audit (rubric.version at time of run)
-- Rule-based scoring (always populated)
total_score           decimal(10,4) NOT NULL           -- 0-120
section_scores        jsonb NOT NULL                   -- { [sectionId]: SectionResult }
signals_summary       jsonb NOT NULL                   -- aggregated metrics (see §4)
data_quality          jsonb NOT NULL                   -- {missingBodies, truncatedBodies, capturedRequests, totalRequests}
-- LLM Deep Analysis (NULL unless llm_eval_enabled)
llm_narrative         text
llm_evidence          jsonb                            -- [{quote, requestId, capturedAt}]
llm_model             text                             -- the model used for eval
llm_called_at         timestamptz
llm_cost_usd          decimal(20,10)
llm_upstream_account_id uuid                           -- which org account was charged
-- Trigger / audit
triggered_by          text NOT NULL                    -- cron | admin_rerun | on_new_user
triggered_by_user     uuid FK                          -- NULL for cron
created_at            timestamptz NOT NULL default now()
updated_at            timestamptz NOT NULL default now()

UNIQUE (user_id, period_start, period_type)           -- upsert on rerun
```

**Indexes:**
- `(user_id, period_start DESC)` — member own-view + admin detail
- `(org_id, period_start DESC)` — org-level aggregations
- `(team_id, period_start DESC) WHERE team_id IS NOT NULL` — team view

### 2.5 `gdpr_delete_requests` (soft-delete queue for member-initiated wipes)

```
id                    uuid PK
org_id                uuid NOT NULL FK
user_id               uuid NOT NULL FK                 -- subject
requested_at          timestamptz NOT NULL default now()
requested_by_user_id  uuid FK                          -- usually same as user_id; admin-on-behalf allowed
reason                text
approved_at           timestamptz
approved_by_user_id   uuid FK                          -- org_admin
rejected_at           timestamptz
rejected_reason       text
executed_at           timestamptz                      -- NULL until purge worker runs
scope                 text NOT NULL                    -- 'bodies' | 'bodies_and_reports'
```

On `approved_at` set: a dedicated worker deletes `request_bodies` (and optionally `evaluation_reports`) for that user. `usage_logs` rows are **not** deleted (they're the billing truth); the user row may stay as tombstone per existing auth model.

### 2.6 RBAC action additions

Extend `@aide/auth/src/rbac/actions.ts`:

```
// Content capture settings
| { type: 'content_capture.read', orgId: string }
| { type: 'content_capture.toggle', orgId: string }
// Reports
| { type: 'report.read_own' }
| { type: 'report.read_user', orgId: string, targetUserId: string }
| { type: 'report.read_team', orgId: string, teamId: string }
| { type: 'report.read_org', orgId: string }
| { type: 'report.rerun', orgId: string, targetUserId: string, periodStart: string }
| { type: 'report.export_own' }
| { type: 'report.delete_own' }  // triggers gdpr_delete_requests insert
// Rubrics
| { type: 'rubric.read', orgId: string }
| { type: 'rubric.create', orgId: string }
| { type: 'rubric.update', orgId: string, rubricId: string }
| { type: 'rubric.delete', orgId: string, rubricId: string }
// Evaluator status
| { type: 'evaluator.read_status', orgId: string }
```

Policy follows Plan 4A conventions — see §6 for the full access matrix.

### 2.7 Key decisions (Section 2 decision log)

| Decision | Chosen | Rationale |
|---|---|---|
| Capture consent scope | Org-level boolean with member visibility | Legal clarity (employer monitoring relationship); consistent data |
| Body primary key | `request_id` (FK to `usage_logs`) | 1:1 relationship; no independent lifecycle; cascade cleanup |
| Encryption | AES-256-GCM + HKDF, domain `body-v1`, salt = `request_id` | Reuses `@aide/gateway-core` cipher; per-row sub-key |
| Cleartext metadata columns | `request_params`, `stop_reason`, user-agent, session-id | Non-content; needed for WHERE filters and data quality |
| Rubric storage | JSONB in dedicated `rubrics` table | Same shape as CLI JSON; org-level customization |
| Reports: perpetual retention | Score + evidence are aggregated artifacts | Historical trends have lasting value; bodies 90d is the privacy-sensitive side |
| GDPR delete: separate queue with approval | Explicit admin workflow | Prevents accidental self-wipe; auditable |
| Body-store abstraction (interface only) | Postgres impl in 4B, S3 stub | Self-host default simple; enterprise scale path preserved |

---

## Section 3 — Body Capture Pipeline

### 3.1 Where capture attaches in Plan 4A's request pipeline

Reference: Plan 4A Section 3.1, the 12-step pipeline. Capture inserts a **Step 10a**, parallel and non-blocking alongside the existing Step 10 (usage_log enqueue):

```
...
Step  9. Response / stream handling (OpenAI-compat translation)
Step 10. Usage log emission (async, BullMQ aide:gw:usage-log)
Step 10a. NEW: Body capture emission (async, BullMQ aide:gw:body-capture)
  - Enqueue only if ctx.org.contentCaptureEnabled === true
  - Payload: { requestId, orgId, userId, rawRequestBody, rawResponseBody, streamedTranscript, attemptErrors }
Step 11. Slot release
Step 12. Response return
```

**Critical property:** body capture NEVER blocks the response to the client. If enqueue fails, gateway writes `body_capture_enqueue_failed` metric + structured log + continues; the usage_log row still lands (billing integrity preserved; eval coverage degrades gracefully).

### 3.2 Stream reconstruction (assistant transcript)

For `stream=true` requests, the gateway streams chunks through the smart-buffer + translator (Plan 4A §3.4). For capture, we need the **assembled final transcript** not the raw chunks:

- The translator already has a final assembled view post-`message_stop` (that's what populates `usage_logs` token counts)
- Extend the translator state machine to also emit the concatenated text + tool blocks to a capture buffer at the same point
- Capture emission is one shot per request (not per chunk) — the buffer is built up during streaming and flushed to BullMQ at stream end

No per-chunk capture in 4B (see non-goals).

### 3.3 Body-capture BullMQ worker

Runs in-process in `apps/gateway` (like the usage-log worker from Plan 4A §5.1). Concurrency 4, batch 100 rows / 1s flush.

```
for each job:
  sanitize(rawRequestBody)       // mask password/secret/token keys per §2.2
  sanitize(rawResponseBody)
  sanitize(attemptErrors)
  if rawRequestBody.content.includes image blocks:
    extract { mimeType, sizeBytes, sha256 } → attachments_meta
    replace image data with {type:'image_ref', sha256}  (not stored separately in 4B)
  gzip each body
  check 256KB cap → apply truncation order (§2.2)
  encrypt each body via @aide/gateway-core cipher:
    deriveKey(master=CREDENTIAL_ENCRYPTION_KEY, salt=requestId, info="aide-gateway-body-v1")
    encryptAES256GCM(compressedBody) → {nonce, ciphertext, authTag}
    concat into bytea column: nonce || ciphertext || authTag
  INSERT into request_bodies (ON CONFLICT DO NOTHING — idempotent)
```

**Idempotency:** job id = `requestId`. Duplicate enqueue (retry after partial failure) produces no duplicate row.

**Retention:** `retention_until` set on insert to `now() + org.retention_days_override ?? '90 days'`.

### 3.4 Retention purge cron

Runs every 4 hours inside `apps/gateway`:

```
DELETE FROM request_bodies
WHERE retention_until <= now()
LIMIT 10000;  -- batch to avoid long lock
-- Loop until no rows affected, then sleep.
```

Metrics: `gw_body_purge_deleted_total`, `gw_body_purge_duration_seconds`.

### 3.5 Toggle-off behavior (org disables capture)

When `organizations.content_capture_enabled` flips to `false`:

- Gateway: Step 10a short-circuits (no new captures)
- Existing `request_bodies` rows stay subject to their original `retention_until`
- Additionally: the admin UI offers a "wipe existing captures now" action that sets `retention_until = now()` for all rows in that org, triggering the next purge cycle
- `evaluation_reports` are **not** touched — they're derived artifacts; the raw bodies disappear but the scored evidence stays

### 3.6 GDPR delete request flow

```
Member: POST /trpc/reports.deleteOwn { scope: 'bodies_and_reports' }
  → INSERT gdpr_delete_requests row with approved_at = null
  → email / notify org_admin
Admin: PUT /trpc/reports.approveDelete { requestId }
  → sets approved_at, triggers worker
Worker:
  DELETE FROM request_bodies WHERE user_id = subject
  IF scope = 'bodies_and_reports': DELETE FROM evaluation_reports WHERE user_id = subject
  SET gdpr_delete_requests.executed_at = now()
  audit_log INSERT
```

Timeline: legally 30 days is the outer bound (GDPR Art. 12); worker-executed ~instant.

### 3.7 Capture observability

Metrics (exposed on `apps/gateway`'s existing `/metrics`):

```
gw_body_capture_enqueued_total{result="ok|dropped_disabled|enqueue_failed"}
gw_body_capture_persisted_total
gw_body_capture_size_bytes          histogram  (pre-encryption, pre-gzip)
gw_body_capture_compression_ratio   histogram
gw_body_capture_truncated_total
gw_body_capture_sanitized_keys_total
gw_body_purge_deleted_total
gw_gdpr_delete_executed_total
```

---

## Section 4 — Evaluator Engine

### 4.1 Rule-based baseline (always on)

Pure function `evaluate(rubric, window) → Report`. Lives in `packages/evaluator`.

**Input resolution phase** — for a (user, period_start, period_end) window:

```
usageRows   = SELECT * FROM usage_logs
              WHERE user_id = ? AND created_at >= period_start AND created_at < period_end
              ORDER BY created_at
bodyRows    = SELECT * FROM request_bodies WHERE request_id IN (...)
              (filter to only those we have bodies for)
decryptedBodies = bodyRows.map(decryptWithMasterKey)
```

**Signal collection phase** — for each rubric section, collect all configured signals:

| Signal type | Source | Behavior |
|---|---|---|
| `keyword` (in `request_body` / `response_body` / `both`) | body text | Count matches, collect evidence quotes (±80 chars context, request_id attached) |
| `threshold` (metric, gte/lte/between) | aggregated usage_logs | Compute metric, compare, produce 0/1 signal |
| `refusal_rate` | `request_bodies.stop_reason` | `count(stop_reason='refusal') / total` |
| `client_mix` | `request_bodies.client_user_agent` | Parse UA, bucket to {claude-code, cursor, raw-sdk, other}, compare minRatio |
| `model_diversity` | `usage_logs.requested_model` | Distinct count |
| `cache_read_ratio` | `usage_logs.cache_read_tokens / usage_logs.input_tokens` | Aggregate ratio |
| `extended_thinking_used` | `request_bodies.request_params.thinking.budget_tokens > 0` | Boolean, count |
| `tool_diversity` | `request_bodies.response_body → tool_use blocks` | Distinct tool names |
| `iteration_count` | Multi-turn messages in request_body per conversation | Count turns per session (needs client_session_id grouping) |
| `goal_keyword` | Old CLI-style keyword on first prompt | Uses `request_body.messages[0].content` |

**Scoring phase** (per section, mirrors CLI's `src/analyzers/section.ts`):

```
let sectionScore = 100   // standard baseline
let signals = []
for each signal config in section.signals:
  const result = collectSignal(signal, data)
  if result.hit: signals.push(result)

const superiorReached = shouldScoreSuperior(section, signals)
if superiorReached: sectionScore = section.superior.score (usually 120)

sectionResult = { sectionId, score, label, signals, evidence: [...signals.evidence] }
```

**Aggregation phase:**

```
weightedTotal = Σ (sectionScore × section.weight / 100)
clamp to [0, 120]
signalsSummary = {
  requests: usageRows.length,
  tokens: Σ input + output,
  cost_usd: Σ total_cost,
  cache_read_ratio,
  model_mix: { [model]: count },
  client_mix: { [ua_bucket]: count },
  refusal_rate,
  body_capture_coverage: bodyRows.length / usageRows.length
}
dataQuality = { capturedRequests, missingBodies, truncatedBodies, totalRequests }
```

**Upsert** the result into `evaluation_reports` with the UNIQUE `(user_id, period_start, period_type)` constraint — reruns overwrite.

### 4.2 LLM Deep Analysis (opt-in)

Runs **after** rule-based phase, conditional on `organizations.llm_eval_enabled`.

**Prompt construction** (in `packages/evaluator/src/llm/promptBuilder.ts`):

```
System:
  You are evaluating a software engineer's AI-assisted development quality
  for the period [period_start, period_end]. Use the provided rubric verbatim
  for scoring criteria. Output structured JSON matching the provided schema.

User:
  Rubric: <full rubric JSON>

  Signals already computed (rule-based):
  <signalsSummary>

  Captured conversation snippets (up to 20 most representative, each ≤2KB):
  <sampled bodies, chronological, tagged with requestId>

  Respond as JSON: {
    "narrative": "2-3 paragraph assessment",
    "evidence": [{ "quote": "...", "requestId": "...", "rationale": "..." }],
    "sectionAdjustments": [{ "sectionId": "...", "adjustment": 0-10, "rationale": "..." }]  // narrative may nudge but not replace rule-based scores
  }
```

**Snippet sampling** — don't send all bodies, compose a representative 20:
- All refusal responses (signal of difficulty)
- All requests with extended_thinking
- First + last request of each session (start + conclusion)
- Requests with tool_use (shows what tools got used)
- Up to `remaining_slots` randomly distributed

Each snippet: `{requestId, clientSessionId, timestamp, requestExcerpt (first 1KB), responseExcerpt (first 1KB)}`.

**Execution** — the evaluator **calls its own gateway** using the org's designated `llm_eval_account_id`:

```
POST http://gateway:3002/v1/messages
Authorization: Bearer <internal-eval-api-key>  // dedicated api_key issued at org enable time, rate-limited separately
body: { model: org.llm_eval_model, max_tokens: 4000, messages: [...] }
```

**Cost attribution:** the call lands in `usage_logs` like any other gateway traffic — bound to `llm_eval_account_id` — so the org sees evaluator spend alongside their other usage. No mystery billing.

**Resilience:**
- LLM call fails → rule-based report still written; `llm_narrative = NULL`, `llm_called_at = NULL`; metric `gw_eval_llm_failed_total` emitted
- LLM returns malformed JSON → fail gracefully, same NULL fallback
- LLM responds but rule-based phase says data_quality is too poor (< 50% body coverage) → skip LLM call, save cost

### 4.3 Cron schedule

```
Every day at 00:05 UTC:
  for each org where content_capture_enabled:
    for each active user in org:
      period_start = yesterday 00:00 UTC
      period_end   = today     00:00 UTC
      enqueue aide:gw:evaluator { orgId, userId, periodStart, periodEnd, periodType:'daily' }
```

BullMQ worker consumes, with concurrency 8 (tunable), max 500 jobs/day/org. Per-job timeout 2 minutes.

### 4.4 Manual rerun

Admin POST `/trpc/reports.rerun { orgId, scope: 'user' | 'team' | 'org', targetId, periodStart, periodEnd }`:

- Checks RBAC: `report.rerun` action
- Validates window ≤ 30 days
- Enqueues same shape of jobs as cron
- Returns `{ enqueuedCount }` — UI shows "Rerunning N reports; refresh in a few minutes"

### 4.5 Evaluator queue failure posture

| Failure | Behavior |
|---|---|
| Redis down (strict mode) | Gateway refuses new eval-queue publishes → cron logs + skip; next cron tries again |
| Postgres down on insert | BullMQ retries (3 attempts × exp backoff); after exhaustion → DLQ `gw_eval_dlq` + alert |
| LLM upstream down | Rule-based result still written; `llm_narrative NULL`; retry LLM-only on next manual rerun |
| Rubric corrupted | Fail loudly: throw, don't write partial report; alert |
| Member has 0 captured requests in window | Skip: don't create an empty report. Metric `gw_eval_skipped_no_data_total` |

---

## Section 5 — Rubric Structure and Versioning

### 5.1 Rubric JSON schema (extends CLI's `EvalStandard`)

```typescript
// packages/evaluator/src/rubric/schema.ts
const rubricSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  version: z.string(),                             // semver
  locale: z.enum(['en', 'zh-Hant', 'ja']).default('en'),
  sections: z.array(z.object({
    id: z.string(),                                // 'interaction' | 'risk' | ... (stable ids for aggregation)
    name: z.string(),
    weight: z.string().regex(/^\d{1,3}%$/),        // '20%'
    standard: z.object({
      score: z.number(),
      label: z.string(),
      criteria: z.array(z.string()),
    }),
    superior: z.object({
      score: z.number(),
      label: z.string(),
      criteria: z.array(z.string()),
    }),
    signals: z.array(signalSchema),
    superiorRules: z.object({
      strongThresholds: z.array(z.string()),       // references signal ids
      supportThresholds: z.array(z.string()),
      minStrongHits: z.number().default(1),
      minSupportHits: z.number().default(1),
    }).optional(),
  })),
  noiseFilters: z.array(z.string()).optional(),    // regex patterns to drop from evidence (e.g. code review boilerplate)
})

// Discriminated signal schema
const signalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('keyword'), id: z.string(), in: z.enum(['request_body', 'response_body', 'both']), terms: z.array(z.string()), caseSensitive: z.boolean().default(false) }),
  z.object({ type: z.literal('threshold'), id: z.string(), metric: metricEnum, gte: z.number().optional(), lte: z.number().optional(), between: z.tuple([z.number(), z.number()]).optional() }),
  z.object({ type: z.literal('refusal_rate'), id: z.string(), lte: z.number() }),
  z.object({ type: z.literal('client_mix'), id: z.string(), expect: z.array(z.string()), minRatio: z.number() }),
  z.object({ type: z.literal('model_diversity'), id: z.string(), gte: z.number() }),
  z.object({ type: z.literal('cache_read_ratio'), id: z.string(), gte: z.number() }),
  z.object({ type: z.literal('extended_thinking_used'), id: z.string(), minCount: z.number() }),
  z.object({ type: z.literal('tool_diversity'), id: z.string(), gte: z.number() }),
  z.object({ type: z.literal('iteration_count'), id: z.string(), gte: z.number() }),
])
```

### 5.2 Platform-default rubrics (seeded)

`packages/evaluator/rubrics/` ships with:

1. `platform-default.en.json` — translated-forward from `templates/eval-standard.json`, with gateway-signal equivalents backfilled where CLI facets don't exist
2. `platform-default.zh-hant.json` — zh version
3. `platform-default.ja.json` — ja version

These get seeded into `rubrics` table with `org_id = NULL, is_default = true`. Orgs without custom rubric use the locale-matching default.

### 5.3 Org custom rubrics

Admin UI at `/dashboard/organizations/[id]/evaluator/rubrics`:
- List rubrics in org (incl. platform default shown as read-only)
- Create — upload JSON or fill in form
- Validate against Zod schema pre-submit
- Assign one as the org's active rubric (`organizations.rubric_id`)

**Rubric hot-reload:** changing active rubric does NOT retrigger past reports. A banner shows "This rubric takes effect from next evaluation run." Admin can click "Rerun last 30 days" to backfill.

### 5.4 Versioning & audit snapshot

Each `evaluation_reports` row stores `rubric_id` + `rubric_version`. If admin edits rubric later, old reports keep the snapshot version visible in UI — no retroactive rescoring without explicit rerun.

---

## Section 6 — UI and Access Model

### 6.1 Admin surfaces (`apps/web`)

**`/dashboard/organizations/[id]/evaluator/settings`** (requires `content_capture.toggle`):
- Master switch: Enable content capture
- Retention override (30 / 60 / 90 days)
- LLM Deep Analysis: toggle + select `upstream_account` + select model + capture_thinking sub-toggle
- Rubric: active rubric dropdown (platform defaults + org custom)
- Leaderboard: enable team-internal ranking
- "Wipe existing captures now" dangerous-action button (confirm modal)

**`/dashboard/organizations/[id]/evaluator/rubrics`** (requires `rubric.*`):
- List all rubrics (platform defaults read-only; org custom editable)
- Create / edit / delete custom rubric
- Test rubric: "Dry run against last 7 days" — doesn't write reports, shows preview

**`/dashboard/organizations/[id]/evaluator/status`** (requires `evaluator.read_status`):
- Last cron run timestamp, next scheduled run
- Queue depth, DLQ count
- Per-user coverage: "N of M members had reports written yesterday"

**`/dashboard/organizations/[id]/members`** page — extend:
- Add "Latest score" column for members (requires `report.read_org`)
- Row click → member detail

**`/dashboard/organizations/[id]/members/[uid]`** — new/extended:
- Trend chart (30-day line)
- Latest report: all section scores + evidence
- LLM narrative (if enabled)
- "Rerun this period" button (admin only)

**`/dashboard/organizations/[id]/teams/[tid]`** — extend:
- Team aggregate: average score, trend chart
- Team member list with scores
- (Optional) Ranking if `leaderboard_enabled`

### 6.2 Member surfaces (`apps/web/src/app/dashboard/profile`)

**`/dashboard/profile/evaluation`** — new:
- Header banner: "Your organization has enabled AI-usage evaluation. Data retention: 90 days. Contact: <org_admin_email>."
- Trend chart (30-day) — member sees only own
- Latest report detail — all sections, all evidence, LLM narrative if present
- "Export my data" button — generates JSON export of reports + captured bodies (decrypted for export)
- "Request deletion" button → opens `gdpr_delete_requests` flow

**No "everyone else's score" surface to members.** Leaderboard (if enabled) is surfaced at the team level where `team_manager` + team members can see each other, but only at the team scope.

### 6.3 Super_admin surface

- `/dashboard/super_admin/platform/evaluator` (new, super_admin only):
  - Cross-org aggregates: how many orgs enabled capture, total captured bodies, purge lag, LLM spend by org
  - **No access to individual reports or bodies.** This is strict: super_admin is platform ops, not customer-data-accessor

### 6.4 RBAC matrix

| Action | super_admin | org_admin | team_manager | member |
|---|---|---|---|---|
| `content_capture.toggle` | ✗ (not their data) | ✓ (own org) | ✗ | ✗ |
| `rubric.*` | ✗ | ✓ (own org) | ✗ | ✗ |
| `report.read_own` | — | ✓ (self) | ✓ (self) | ✓ (self) |
| `report.read_user` | ✗ | ✓ (any user in org) | ✗ | ✗ |
| `report.read_team` | ✗ | ✓ (any team in org) | ✓ (own team only) | ✗ |
| `report.read_org` | ✗ | ✓ (own org) | ✗ | ✗ |
| `report.rerun` | ✗ | ✓ (own org) | ✗ | ✗ |
| `report.export_own` | — | ✓ (self) | ✓ (self) | ✓ (self) |
| `report.delete_own` | — | ✓ (self) | ✓ (self) | ✓ (self) |
| `evaluator.read_status` | ✗ (platform-level in super_admin surface) | ✓ (own org) | ✓ (own org status only) | ✗ |
| Platform aggregates (no individual) | ✓ | ✗ | ✗ | ✗ |

### 6.5 Consent UI contract

First time an org admin flips content-capture ON:
1. Modal shows: "Enabling this captures all request/response bodies for members of this org. Retention: 90 days (adjustable). Members will see this banner on their profile: '<banner text>'. You can disable anytime; existing bodies obey retention window unless wiped."
2. Admin must tick "I have informed members and have lawful basis"
3. Confirm → writes `content_capture_enabled_at`, `content_capture_enabled_by`
4. Audit log entry: `contentCapture.enabled` with actor + timestamp
5. Members on next `/dashboard/profile` visit see a banner pointing to `/profile/evaluation`

---

## Section 7 — Operations

### 7.1 SLO targets (4B addition)

Layered on Plan 4A's baseline 99.0% / aspirational 99.5% gateway availability:

| SLI | Target | Window | Note |
|---|---|---|---|
| Body capture success rate | ≥ 99% | 1h rolling | `persisted / enqueued` — includes truncation/sanitize as success |
| Evaluator cron completion | ≥ 99% of scheduled runs complete within 30min | daily | Failure = manual rerun required next day |
| Body purge lag | < 4h past retention_until | continuous | Otherwise GDPR exposure |
| GDPR delete execution | < 1h after approval | continuous | Delete worker responsiveness |

### 7.2 Failure posture matrix (4B additions)

| Failure | Behavior |
|---|---|
| `request_bodies` insert fails (Postgres down) | BullMQ retries; after DLQ, logged and alerted; gateway response to client unaffected |
| Sanitizer error (malformed JSON) | Best-effort capture with raw content + `sanitization_error: true` flag in metadata |
| Encryption failure (master key missing) | Gateway refuses to accept writes to request_bodies; falls back to usage_log-only path; alerts |
| Evaluator cron fails | Reports just not produced; next cron reprocesses same window if window not yet purged |
| LLM call returns non-JSON | Report saved with rule-based scores, `llm_narrative = null`; `gw_eval_llm_parse_failed_total` |
| Member has 0 captured requests | Report skipped; `gw_eval_skipped_no_data_total`; member detail page shows "No activity this period" |
| GDPR delete worker crashes mid-batch | Idempotent — rerun continues where left off (per-row DELETE; no state machine) |
| Rubric upgrade mid-run | Cron run uses whatever `rubric.version` was active at cron-enqueue time; reports snapshot it |

### 7.3 Metrics / alerts added

On top of Plan 4A's metrics:

```
gw_body_capture_enqueued_total{result}
gw_body_capture_persisted_total
gw_body_capture_size_bytes              histogram
gw_body_capture_compression_ratio       histogram
gw_body_capture_truncated_total
gw_body_capture_sanitized_keys_total

gw_body_purge_deleted_total
gw_body_purge_duration_seconds
gw_body_purge_lag_hours                 gauge  — time since oldest overdue purge

gw_eval_jobs_enqueued_total
gw_eval_jobs_completed_total{result}
gw_eval_jobs_duration_seconds
gw_eval_rule_based_only_total
gw_eval_llm_called_total
gw_eval_llm_cost_usd                    counter
gw_eval_llm_failed_total{reason}
gw_eval_llm_parse_failed_total
gw_eval_skipped_no_data_total
gw_eval_dlq_count                       gauge

gw_gdpr_delete_pending                  gauge
gw_gdpr_delete_executed_total
gw_gdpr_delete_duration_seconds
```

### 7.4 Runbook additions

1. **Body purge lag > 24h** — DB under load or purge cron crashed. Check `gw_body_purge_duration_seconds` + Postgres `pg_stat_activity`. Run manual purge via maintenance script.

2. **Evaluator queue depth growing** — LLM calls stalling or rule-based phase slow. Check upstream account health first (an eval-dedicated account might be rate-limited).

3. **GDPR delete approval stuck** — check `gdpr_delete_requests WHERE approved_at IS NULL AND requested_at < now() - '7 days'`. SLA for org admin response.

4. **Reports missing for a subset of members** — typically no captured bodies in window (member didn't use AI that day). Verify with `request_bodies` count per user_id. Expected for inactive days.

5. **LLM cost spike** — member has generated many sessions; cost attributed to `llm_eval_account_id`. If unexpected, check if capture_thinking is enabled (thinking blocks can dominate).

6. **Rubric validation rejects on upload** — Zod errors returned to UI; common: wrong weight format (`"20%"` not `0.2`), missing `id` fields on sections or signals.

---

## Section 8 — Rollout, Feature Flag, and Migration

### 8.1 Feature gate

- Env: `ENABLE_EVALUATOR=false` default
- Multi-layer:
  - Orchestration: evaluator cron + body-capture worker do not register in gateway if flag false
  - API: `contentCapture.*` / `rubrics.*` / `reports.*` / `evaluator.*` routers throw NOT_FOUND
  - UI: evaluator pages hidden from nav; direct URL access shows 404

When flipped to true + `ENABLE_GATEWAY=true` already holds:
- Platform-default rubrics seeded via migration into `rubrics` with `is_default=true`
- Body-capture worker starts consuming `aide:gw:body-capture`
- Cron schedule registered (00:05 UTC daily)
- Existing orgs: `content_capture_enabled = false`; they opt in via admin UI

### 8.2 Migration

`0002_evaluator.sql` (one migration, additive):

- CREATE TABLE `request_bodies`, `evaluation_reports`, `rubrics`, `gdpr_delete_requests`
- ALTER TABLE `organizations` ADD COLUMN `content_capture_enabled BOOLEAN NOT NULL DEFAULT false`, ... (all the 4B columns from §2.1)
- Indexes per §2

No data backfill: all new orgs and existing orgs start with capture off.

### 8.3 Rollback

Safe-additive; no destructive schema changes. If rollback needed:
1. Disable feature flag
2. Stop gateway cron via env
3. Leave tables in place; old versions ignore them
4. If fully reverting: a future migration drops the tables (NOT included in 4B)

### 8.4 Docker / compose / CI

- No new Docker image
- `docker-compose.yml` unchanged (evaluator runs inside existing gateway service)
- `.env.example` adds `ENABLE_EVALUATOR` + documents `retention_days_override` at org level (not env)
- `ci.yml` adds `evaluator-integration` job (testcontainers Postgres + Redis; exercises full capture → purge → eval round-trip)
- `release.yml` matrix unchanged (no new image)

---

## Decision Log (consolidated)

| # | Area | Decision | Source |
|---|---|---|---|
| 1 | Evaluator depth | **B** — Capture content + full evaluator (not mere usage metrics) | User choice |
| 2 | Consent model | **A + member visibility** — org opt-in + banner + GDPR export/delete + auto-purge on disable | User choice |
| 3 | Body storage | **1+2 hybrid** — Postgres default, S3 stub for 4C growth path | User choice |
| 4 | Evaluation cadence | **C** — Daily cron + admin manual rerun; reports perpetual, bodies 90d | User choice |
| 5 | Capture scope | **D+** — Prompts + responses + tool blocks + params + stop_reason + error chain + attachment meta + cache markers + (opt-in) thinking + 256KB cap + sanitization | User choice + enrichment |
| 6 | Encryption at rest | **B** — AES-256-GCM + HKDF per-request sub-key, reuses `CREDENTIAL_ENCRYPTION_KEY` with `info="aide-gateway-body-v1"` | User choice |
| 7 | Engine | **C** — Rule-based baseline (always on) + LLM Deep Analysis opt-in (dogfooded via org's own upstream account) | User choice |
| 8 | Access model | Members see own full report; team_manager sees team; org_admin sees org; super_admin sees aggregate only; leaderboard default OFF (org can enable team-internal) | User choice |
| 9 | Rubric | Same JSON shape as CLI `eval-standard.json`, extended with gateway-specific signal types; org-customizable via `rubrics` table | Derived |
| 10 | LLM call path | Via org's own gateway using designated `llm_eval_account_id`, routed through `/v1/messages` — cost lands in same `usage_logs` for attribution | Derived |
| 11 | Retention split | Reports perpetual; bodies 90d default (org-overrideable) | User choice |
| 12 | Attachment handling | Image `base64` replaced with `{mime, size, sha256}` metadata; raw bytes not stored | Design hygiene |
| 13 | GDPR delete | Explicit approval workflow (`gdpr_delete_requests` table); admin approves; worker executes; report scope vs body scope selectable | Legal |
| 14 | Feature flag | `ENABLE_EVALUATOR=false` by default, multi-layer gating (orchestration / API / UI) | Plan 4A pattern |

---

## Open questions for Plan 4B → writing-plans handoff

1. **Task decomposition estimate:** roughly 50-55 tasks, ~14 parts, similar scale to Plan 4A. Expected ~2 weeks for subagent-driven execution.

2. **Implementation ordering (proposed):**
   - **Part 1** — Schema + migration + RBAC extensions (no runtime)
   - **Part 2** — `packages/evaluator` pure logic: rubric schema validator, signal collectors, rule engine, prompt builder
   - **Part 3** — Body-capture pipeline in `apps/gateway` (worker, sanitizer, encryption wire-up, retention purge cron)
   - **Part 4** — Evaluator cron worker + BullMQ queue + rule-based execution path
   - **Part 5** — LLM Deep Analysis path (prompt, self-gateway call, narrative parsing)
   - **Part 6** — `apps/api` tRPC routers (contentCapture, rubrics, reports, evaluator)
   - **Part 7** — `apps/web` admin UI (settings, rubrics, status)
   - **Part 8** — `apps/web` member UI (profile/evaluation, export, delete request)
   - **Part 9** — Platform-default rubrics seeded
   - **Part 10** — GDPR delete worker + queue + audit
   - **Part 11** — CI evaluator-integration job + E2E smoke spec
   - **Part 12** — Docs (GATEWAY.md extension for capture, new docs/EVALUATOR.md, SELF_HOSTING.md update)
   - **Part 13** — Feature-flag rollout playbook + manual acceptance runbook
   - **Part 14** — v0.4.0 tag + README + CHANGELOG

3. **Things that may shift during implementation:**
   - Signal types list may grow (expect to add 2-3 more after real data is seen)
   - LLM snippet sampling strategy — currently heuristic; may need tuning after observing actual report quality
   - Rubric default — the translated-from-CLI version may need revision once gateway signals are hooked up (some CLI sections may have no gateway equivalent and need removal/replacement)

---

*End of Plan 4B design document.*



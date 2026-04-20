# Plan 4A — Gateway Design

**Status:** Brainstorm complete (2026-04-20), pending user review
**Target release:** v0.3.0
**Predecessor:** Plan 3 (v0.2.0 — platform shell)
**Successors:** Plan 4B (evaluator integration) · Plan 4C (multi-provider + pool) · Plan 4D (credit/quota + admin tooling)

---

## Goal

Build the **data-plane half** of aide's AI gateway: a stateless proxy that fronts Anthropic's API, issues per-user API keys, tracks every request at token-level, and writes an append-only `usage_logs` table that Plan 4B's evaluator will consume.

Target **parity with sub2api's core gateway capabilities**, scoped to Anthropic as the sole upstream provider and cloud multi-tenant (mode A) deployment.

## Architecture bar

Match sub2api quality; exceed where it advances evaluator data quality.

- ✅ Account pool with scheduling state machine (5-timestamp states)
- ✅ Per-user + per-account concurrency slots (Redis ZSET + Lua atomic)
- ✅ Cross-account failover (max 10) + same-account retry (3 × 500ms)
- ✅ Smart buffering window (novel — exceeds sub2api's immediate-flush policy)
- ✅ OpenAI-compat translation with incremental tool_calls streaming
- ✅ Idempotency cache, sticky session (opt-in), OAuth refresh

## Non-goals (out of 4A)

- Multi-provider (OpenAI / Gemini) upstream → Plan 4C
- Credit / quota enforcement → Plan 4D (schema fields included, runtime not enforced)
- Rate-limit window counters (5h/1d/7d maintenance) → Plan 4D
- Evaluator / performance dashboards → Plan 4B
- TLS fingerprint profiling
- Prompt intercept / warmup injection
- Localhost single-user mode (mode B) → separate plan
- Built-in payment / subscription plans → Plan 4D

---

## Section 1 — Architecture Overview

### Deployment topology

```
apps/web  (Next.js, :3000)
    │ rewrites /trpc/* → apps/api
    ▼
apps/api  (Fastify, :3001)            apps/gateway  (Fastify, :3002)
    ├─ tRPC only                          ├─ /v1/messages
    ├─ admin CRUD for accounts/keys       ├─ /v1/chat/completions
    ├─ usage query routes                 ├─ /health, /metrics
    ▼                                     ▼
 Postgres (shared)  ◄── @aide/db ───►  Postgres (shared)
        ▲                                 ▲
        └────── Redis (new) ──────────────┘      ─► Anthropic upstream
        (concurrency slots, sticky, wait queue,
         idempotency cache, oauth refresh lock)
```

### Workspace additions

- **NEW `apps/gateway`** — Fastify + Node 20; owns `/v1/*` data plane
- **NEW `packages/gateway-core`** — shared logic between `apps/gateway` (runtime) and `apps/api` (admin CRUD routes)
  - Account CRUD, key CRUD, pricing lookup, OpenAI↔Anthropic translation utils, state-machine helpers, fake upstream test harness
- **Existing packages extended**:
  - `@aide/db` — 4 new tables (`accounts`, `api_keys`, `usage_logs`, `credential_vault`) + 1 migration
  - `@aide/config` — new env vars (see Section 7.1)
  - `@aide/auth` — new RBAC action types (`account.*`, `api_key.*`, `usage.*`)

### Routing boundaries

- **`apps/api` (admin plane):** existing tRPC + new routers `accounts.*`, `apiKeys.*`, `usage.*`. All admin UI CRUD travels here. Session cookie auth.
- **`apps/gateway` (data plane):** only Anthropic / OpenAI-compat clients. No tRPC, no session cookie. API-key auth via `Authorization: Bearer <key>` or `x-api-key`.

### Tech choices

| Concern | Choice | Rationale |
|---|---|---|
| HTTP framework | Fastify (match `apps/api`) | Shared plugin ecosystem + existing team familiarity |
| Upstream HTTP client | `undici` | Best-in-class Node streaming, AbortSignal support |
| Redis client | `ioredis` | Stable, cluster-ready for future scale |
| Queue | `bullmq` on Redis | Durable, crash-safe, already Redis-dependent |
| Pricing source | `pricing/litellm.json` bundled, weekly GitHub Action refresh | No runtime network dep, reviewable diffs |
| Credential encryption | AES-256-GCM with HKDF-derived per-account sub-key | Domain separation + ciphertext uniqueness |
| API key hashing | HMAC-SHA256 with server-side pepper | Protects against offline brute force on DB dump |

### Deployment artifacts

- `docker/Dockerfile.gateway` — multi-stage, mirrors api Dockerfile pattern
- `docker-compose.yml` — adds `redis:7-alpine` + `gateway` service (under profile `gateway` for staged rollout)
- `release.yml` — add `gateway` to the build-push matrix (multi-arch `linux/amd64,linux/arm64`)
- `ci.yml` — new `gateway-integration` job with testcontainers postgres + redis

---

## Section 2 — Data Model

4 new tables in `packages/db/src/schema/`, one migration `0005_gateway_schema.sql`.

### 2.1 `upstream_accounts` (upstream AI account pool)

> **Naming note:** DB table is `upstream_accounts` / TS symbol is `upstreamAccounts`. Renamed from the original draft `accounts` during implementation because NextAuth's adapter already reserved `accounts` (user OAuth credentials). Product-level vocabulary (RBAC action names, tRPC router namespace, UI labels) continues to say "account" / "accounts" — only the DB table + TS schema symbol carry the `upstream_` prefix.

```
id                        uuid PK (uuidv7)
org_id                    uuid NOT NULL → organizations  (required)
team_id                   uuid NULL → teams              (NULL = org-scoped; set = team-override)
name                      text NOT NULL
notes                     text
platform                  text NOT NULL        -- 4A: 'anthropic' only; widen to enum in 4C
type                      text NOT NULL        -- 'api_key' | 'oauth'
-- Scheduling
schedulable               boolean NOT NULL default true
priority                  int NOT NULL default 50          -- lower = higher priority
concurrency               int NOT NULL default 3           -- per-account max concurrent
rate_multiplier           decimal(10,4) NOT NULL default 1.0
-- State machine (5 timestamps, mirror sub2api)
rate_limited_at           timestamptz
rate_limit_reset_at       timestamptz
overload_until            timestamptz
temp_unschedulable_until  timestamptz
temp_unschedulable_reason text
last_used_at              timestamptz
-- OAuth refresh tracking
oauth_refresh_fail_count  int NOT NULL default 0
oauth_refresh_last_error  text
oauth_refresh_last_run_at timestamptz
-- Lifecycle
expires_at                timestamptz
auto_pause_on_expired     boolean NOT NULL default true
status                    text NOT NULL default 'active'   -- 'active' | 'error' | 'disabled'
error_message             text
created_at                timestamptz NOT NULL default now()
updated_at                timestamptz NOT NULL default now()
deleted_at                timestamptz                       -- soft delete
```

**Indexes:**
- `(org_id, team_id) WHERE deleted_at IS NULL`
- `(org_id, team_id, priority) WHERE deleted_at IS NULL AND schedulable = true` — hot path for account selection

### 2.2 `credential_vault` (encrypted credentials, isolated table)

```
id                uuid PK
account_id        uuid NOT NULL UNIQUE → accounts.id ON DELETE CASCADE
nonce             bytea NOT NULL     -- 12 bytes GCM nonce
ciphertext        bytea NOT NULL
auth_tag          bytea NOT NULL     -- 16 bytes GCM auth tag
oauth_expires_at  timestamptz        -- plaintext copy for refresh scheduling (oauth only)
created_at        timestamptz NOT NULL default now()
rotated_at        timestamptz
```

**Single one-way FK** — `credential_vault.account_id → accounts.id ON DELETE CASCADE` with a `UNIQUE(account_id)` constraint enforces 1:1. There is no `accounts.credential_vault_id` back-reference (that would create a circular FK dependency preventing insert). Gateway looks up vault via `SELECT … WHERE account_id = ?`.

**Why isolated from `accounts`:**
- Reduced surface for credential leaks (selecting from `accounts` never yields ciphertext by accident)
- Rotate credentials by inserting new vault row + flipping active pointer (future 4D) without touching `accounts.id` → `usage_logs` FK stable
- Historical credential snapshots (future: keep rotated rows with `rotated_at IS NOT NULL`, drop UNIQUE constraint)

**Indexes:**
- `(account_id)` UNIQUE — lookup on request (1:1 in 4A)
- `(oauth_expires_at) WHERE oauth_expires_at IS NOT NULL` — refresh worker poll

### 2.3 `api_keys` (platform-issued keys for users)

```
id                  uuid PK
user_id             uuid NOT NULL → users
org_id              uuid NOT NULL → organizations
team_id             uuid NULL → teams
key_hash            text NOT NULL UNIQUE    -- HMAC-SHA256(pepper, raw_key), hex
key_prefix          text NOT NULL           -- first 8 chars of raw_key, displayed in UI
name                text NOT NULL
status              text NOT NULL default 'active'  -- 'active' | 'revoked'
ip_whitelist        text[]                  -- CIDRs allowed, NULL/empty = any
ip_blacklist        text[]                  -- CIDRs blocked
-- Quota (schema only — 4A does not enforce; 4D will)
quota_usd           decimal(20,8) NOT NULL default 0        -- 0 = unlimited
quota_used_usd      decimal(20,8) NOT NULL default 0
rate_limit_1d_usd   decimal(20,8) NOT NULL default 0
-- Reveal-tracking (one-time URL flow for admin-issued keys; see Section 6.2)
issued_by_user_id   uuid NULL → users.id     -- NULL if self-issued; set if admin-issued
reveal_token_hash   text NULL                -- HMAC-SHA256(pepper, one_time_token) for admin-issued
reveal_token_expires_at timestamptz NULL     -- 24h from creation
revealed_at         timestamptz NULL         -- when target user first opened reveal URL
revealed_by_ip      inet NULL                -- IP that opened reveal URL
-- Lifecycle
last_used_at        timestamptz
expires_at          timestamptz
created_at          timestamptz NOT NULL default now()
updated_at          timestamptz NOT NULL default now()
revoked_at          timestamptz
```

**Reveal flow invariants:**
- `issued_by_user_id IS NOT NULL` ⟹ admin-issued; `reveal_token_hash` populated at create time
- `issued_by_user_id IS NULL` ⟹ self-issued; the raw key is shown once in the create dialog (no URL needed)
- Admin-issued key is NOT usable until revealed (gateway checks `revealed_at IS NOT NULL OR issued_by_user_id IS NULL` at auth time). Prevents admin from secretly using the key before delivery.
- After `revealed_at`, `reveal_token_hash` and `reveal_token_expires_at` are nulled out (single-use).

**Indexes:**
- `(user_id) WHERE revoked_at IS NULL`
- `(org_id) WHERE revoked_at IS NULL`
- `(key_hash)` — already UNIQUE
- `(reveal_token_hash) WHERE reveal_token_hash IS NOT NULL` — reveal URL lookup

### 2.4 `usage_logs` (append-only, one row per gateway request)

```
id                       bigserial PK
request_id               text NOT NULL UNIQUE             -- client-visible correlation id
-- Associations
user_id                  uuid NOT NULL → users       ON DELETE RESTRICT
api_key_id               uuid NOT NULL → api_keys    ON DELETE RESTRICT
account_id               uuid NOT NULL → accounts    ON DELETE RESTRICT
org_id                   uuid NOT NULL → organizations ON DELETE RESTRICT
team_id                  uuid NULL → teams           ON DELETE SET NULL
-- Model tracking
requested_model          text NOT NULL                     -- what client asked for
upstream_model           text NOT NULL                     -- sent to upstream (usually same)
platform                 text NOT NULL                     -- 'anthropic'
surface                  text NOT NULL                     -- 'messages' | 'chat_completions'
-- Token counts
input_tokens             int NOT NULL default 0
output_tokens            int NOT NULL default 0
cache_creation_tokens    int NOT NULL default 0
cache_read_tokens        int NOT NULL default 0
-- Cost breakdown (all decimal(20,10) USD)
input_cost               decimal(20,10) NOT NULL default 0
output_cost              decimal(20,10) NOT NULL default 0
cache_creation_cost      decimal(20,10) NOT NULL default 0
cache_read_cost          decimal(20,10) NOT NULL default 0
total_cost               decimal(20,10) NOT NULL default 0
rate_multiplier          decimal(10,4)  NOT NULL default 1.0
account_rate_multiplier  decimal(10,4)  NOT NULL default 1.0
-- Observability (evaluator will use these)
stream                   boolean NOT NULL default false
status_code              int NOT NULL
duration_ms              int NOT NULL
first_token_ms           int                              -- TTFT for streaming
buffer_released_at_ms    int                              -- smart buffer window release time (novel metric)
upstream_retries         int NOT NULL default 0
failed_account_ids       uuid[]                           -- failover path
-- Client meta
user_agent               text
ip_address               inet
created_at               timestamptz NOT NULL default now()  (immutable)
```

**Indexes:**
- `(user_id, created_at DESC)`
- `(api_key_id, created_at DESC)`
- `(account_id, created_at DESC)`
- `(org_id, created_at DESC)`
- `(team_id, created_at DESC) WHERE team_id IS NOT NULL` — partial
- `(requested_model)`
- `(request_id)` — already UNIQUE

### 2.5 RBAC action types added to `@aide/auth/rbac/actions.ts`

- `account.read` / `account.create` / `account.update` / `account.rotate` / `account.delete`
- `api_key.issue_own` / `api_key.issue_for_user` / `api_key.list_own` / `api_key.list_all` / `api_key.revoke`
- `usage.read_own` / `usage.read_user` / `usage.read_team` / `usage.read_org`

### 2.6 Key decisions (Section 2 decision log)

| Decision | Chosen | Rationale |
|---|---|---|
| Account scope model | `(org_id, team_id nullable)` two-column FK | Direct FK constraints; `team_id IS NULL` = org-level fallback |
| Credential storage | Isolated `credential_vault` table | Security + rotate-friendly |
| API key hashing | HMAC-SHA256 + server-side pepper | Resistant to DB dump brute force |
| `usage_logs` FK policy | RESTRICT delete (SET NULL for team_id) | Preserve evaluator history; GDPR via soft-delete on user |
| Primary key for `usage_logs` | `bigserial` | High insert volume, never exposed publicly (use `request_id` for that) |
| Quota fields in 4A | Schema included, runtime not enforced | "Schema wide, code narrow" — avoids 4D migration |

---

## Section 3 — Gateway Request Pipeline + Failover

### 3.1 Twelve-step request pipeline

```
 1. Inbound auth
    - Parse Authorization / x-api-key header → compute HMAC-SHA256(pepper, raw_key)
    - Query api_keys by key_hash; validate: not revoked, not expired, IP allowlist/denylist
    - Single JOIN loads { apiKey, user, org, teamId }
    - Failure → 401

 2. Request parse + surface normalize
    - /v1/messages       → parse Anthropic format directly
    - /v1/chat/completions → parse OpenAI format → translate to internal NormalizedRequest (Anthropic shape)
    - Extract { requested_model, stream, surface }
    - Early exit on malformed JSON / over GATEWAY_MAX_BODY_BYTES / missing model

 3. Wait queue admission (Redis ZSET)
    - ZADD aide:gw:wait:user:{user_id} on arrival
    - If ZCARD > maxWait (default 10) → 429 fast

 4. User concurrency slot acquisition (Redis ZSET + Lua)
    - Acquire per-user slot; up to user.concurrency (default 5)
    - 30s timeout → 429
    - On success: ZREM from wait queue

 5. Account selection (DB query with state-machine filtering)
    SELECT id FROM accounts
    WHERE org_id = ?
      AND (team_id = ? OR team_id IS NULL)
      AND deleted_at IS NULL
      AND schedulable = true
      AND (rate_limited_at IS NULL OR rate_limit_reset_at < now())
      AND (overload_until IS NULL OR overload_until < now())
      AND (temp_unschedulable_until IS NULL OR temp_unschedulable_until < now())
      AND id NOT IN <failed_account_ids this attempt>
    ORDER BY
      (team_id IS NULL) ASC,     -- team-scoped first
      priority ASC,
      last_used_at ASC NULLS FIRST
    LIMIT 5
    - Empty → release user slot → 503 no_upstream_available

 6. Per-account concurrency slot (Redis ZSET + Lua)
    - Try acquire slot up to account.concurrency (default 3)
    - Fail → skip to next candidate; exhaust → 503 or enqueue

 7. Credential resolve
    - Fetch credential_vault row, AES-256-GCM decrypt with HKDF-derived sub-key
    - If type='oauth' AND expires_at < now() + 60s → inline refresh (Redis lock, CAS vault update)
    - Build upstream auth header:
      api_key:  x-api-key: <key>, anthropic-version: 2023-06-01
      oauth:    Authorization: Bearer <access>, anthropic-beta: oauth-2025-04-20

 8. Upstream call (undici)
    - POST $UPSTREAM_ANTHROPIC_BASE_URL/v1/messages
    - stream=true → open SSE with AbortSignal from request context
    - Record start_time, first_byte_time

 9. Response / stream handling
    - 200 non-stream  → read body, extract usage field
    - 200 stream      → pipe SSE to client, accumulate usage from message_start / message_delta
    - OpenAI-compat   → chunk-by-chunk translate; tool_use blocks emit incremental tool_calls
    - Smart buffer    → first GATEWAY_BUFFER_WINDOW_MS ms or GATEWAY_BUFFER_WINDOW_BYTES bytes
                         buffered before flushing to client; errors in window → failover
    - Error           → classify → failover or fatal (see 3.2)

10. Usage log emission (async, with inline fallback)
    - Try enqueue job to BullMQ: aide:gw:usage-log
      - job id = request_id (idempotent)
      - Worker batch inserts 100 rows / 1s flush interval (see Section 5)
    - **Enqueue failure path** (Redis timeout / BullMQ add rejection):
      - Emit metric gw_usage_enqueue_fallback_total
      - Inline synchronous fallback: open short DB txn → INSERT usage_logs + UPDATE api_keys.quota_used_usd — same as worker's batched path, but for one row
      - Adds ~10–30ms to response close on the rare failure case; preserves billing integrity (no silent loss)
      - If inline fallback ALSO fails (e.g. Postgres down): write structured log line `gw_usage_persist_lost` to pino at `error` level with full payload so operator can replay from logs → alert `gw_usage_persist_lost_total`
    - Response is NOT retroactively failed — client already received success; we only backfill accounting on a best-effort chain (queue → inline → log)

11. Slot release
    - ZREM per-account slot, then per-user slot
    - ZREM wait counter (if still held)

12. Response return
    - All responses include X-Request-Id header (support ticket anchor)
    - On error: JSON body with { error: { code, message, request_id } }
```

### 3.2 Error classification → state machine

| Upstream response | Account state change | Failover? |
|---|---|---|
| `401` / `403` (auth invalid) | `status='error'` + `error_message=<msg>` | ✅ switch account |
| `429` (rate limited) | `rate_limited_at=now`, `rate_limit_reset_at=parse(Retry-After)` | ✅ switch |
| `529` (overloaded) | `overload_until=now + 60s` | ✅ switch |
| Other `5xx` transient | `temp_unschedulable_until=now + 30s`, reason=`<code>` | ✅ switch |
| Connection error / timeout | no state change | 🔁 same-account retry 3× × 500ms → then switch |
| `4xx` (400 / 422 / client error) | no state change | ❌ return error directly |
| Context length exceeded | no state change | ❌ return error directly |

### 3.3 Failover constraints

- **Max cross-account switches:** 10 (env `GATEWAY_MAX_ACCOUNT_SWITCHES`, match sub2api default)
- **Same-account retries:** 3 × 500ms (connection / timeout only)
- **Exhausted:** `503 all_upstreams_failed` with `request_id`
- All error bodies include `request_id` for support ticket anchoring

### 3.4 Mid-stream failure — Smart buffering window (novel)

The buffer window is our quality edge over sub2api.

```
Request → upstream call
        ↓
  [buffer to client]
    - First GATEWAY_BUFFER_WINDOW_MS ms (default 500) OR
      GATEWAY_BUFFER_WINDOW_BYTES bytes (default 2048), whichever first
    - Upstream error within window → discard buffer, failover transparently
    - Window expires → commit to current account, flush buffer, begin streaming
        ↓
  [after commit]
    - Upstream error → send `event: error` SSE chunk (no failover — already committed)
    - Log with upstream_retries = 0, partial token counts, buffer_released_at_ms
```

- Admin can override per account or per api_key (`buffer_ms`, `buffer_bytes` columns — 4D).
- `buffer_window_ms=0, buffer_window_bytes=0` → identical to sub2api (immediate passthrough).
- `buffer_window_bytes=unlimited` → effectively non-stream (complete fault tolerance, no TTFT benefit).
- **Observability:** `usage_logs.buffer_released_at_ms` records the actual release time, allowing evaluator to analyze TTFT impact.

### 3.5 OpenAI-compat translation (incremental tool_calls)

Translation happens only at the **request entry** and **response exit**; core pipeline operates on `NormalizedRequest` / `NormalizedResponse` (Anthropic shape).

**Request translation (`POST /v1/chat/completions` → internal):**
- `messages[role=system]` → extracted into top-level `system` field
- `tools[]` → reshape field names (OpenAI `parameters` → Anthropic `input_schema`)
- `max_tokens` → direct passthrough
- `stream_options` → ignored (Anthropic always emits usage via `message_delta`)

**Response translation (non-stream):**
- `content[]` → concat text blocks → `choices[0].message.content`
- `stop_reason` → `finish_reason`: `end_turn→stop`, `max_tokens→length`, `tool_use→tool_calls`
- `usage` → `{ prompt_tokens: input, completion_tokens: output, total_tokens }`

**Response translation (stream — incremental tool_calls):**
- Anthropic SSE `content_block_start(tool_use)` → OpenAI `choices[0].delta.tool_calls[n].id + .function.name`
- Anthropic SSE `input_json_delta` → OpenAI `choices[0].delta.tool_calls[n].function.arguments` (chunk-by-chunk append)
- Anthropic SSE `content_block_stop(tool_use)` → signal only (no payload — OpenAI client concatenates)
- Anthropic SSE `message_stop + stop_reason=tool_use` → OpenAI `finish_reason=tool_calls`

Unit tests: `packages/gateway-core/test/fixtures/streams/` holds paired request / response SSE fixtures; snapshot tests cover each event transformation.

### 3.6 Additional quality items (included in 4A scope)

- **Request body size limit** — Fastify middleware, default 10MB (`GATEWAY_MAX_BODY_BYTES`)
- **Idempotency** — Client `X-Request-Id` header deduped via Redis for 5 minutes; non-stream responses cached; stream responses stored as `{ status: "in_progress" }` marker with duplicate → `409 Conflict + Retry-After`
- **Client disconnect propagation** — `AbortSignal` piped to undici; client TCP close → upstream TCP close → stop billing
- **Error passthrough rules** — deferred in full (schema + UI + runtime) to Plan 4D. 4A always applies the built-in classification table in 3.2; no admin overrides.

### 3.7 Explicitly skipped in 4A

- TLS fingerprint profiles — maintenance burden, ToS gray area; reconsider in 4C
- Prompt intercept / warmup injection — attack surface + conflicts with clean evaluator data

---

## Section 4 — Redis Design

All keys prefixed `aide:gw:`. Six use cases, each with explicit TTL.

### 4.1 Key schema

| Use case | Key | Type | TTL / expiry |
|---|---|---|---|
| Per-user concurrency slot | `aide:gw:slots:user:{user_id}` | ZSET (member=request_id, score=expiry_ms) | EXPIRE 5min (safety net) + per-member score |
| Per-account concurrency slot | `aide:gw:slots:account:{account_id}` | ZSET | same |
| Wait queue | `aide:gw:wait:user:{user_id}` | ZSET | same |
| Account hot-state cache | `aide:gw:state:account:{account_id}` | HASH (rate_limited_at, overload_until, …) | EXPIRE 60s; DEL on DB update |
| Sticky session | `aide:gw:sticky:{org_id}:{session_id}` | STRING (account_id) | EXPIRE 1h |
| Idempotency cache | `aide:gw:idem:{request_id}` | STRING (JSON: status+headers+body) | EXPIRE `GATEWAY_IDEMPOTENCY_TTL_SEC` (default 300) |
| OAuth refresh lock | `aide:gw:oauth-refresh:{account_id}` | STRING (SET NX) | EXPIRE 30s |

### 4.2 Slot acquire / release (Lua atomic)

ZSET per-member expiry score outperforms `INCR`/`DECR`: dead handlers (Node crash, process kill) don't permanently occupy slots — `ZREMRANGEBYSCORE` cleanup happens on next acquire attempt.

```lua
-- ACQUIRE slot (KEYS[1]=slots key; ARGV={now_ms, expiry_ms, request_id, limit})
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])  -- cleanup stale
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[4]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], 300)                        -- safety net
return 1
```

Release: `ZREM <key> <request_id>`. Not atomic with release, but worst case the expiry score cleans up on next acquire — acceptable.

### 4.3 Account state cache

- Account selection (Step 5) first queries `state:account:{id}` — miss falls through to DB.
- DB writes (updating `rate_limited_at`, `overload_until`, `temp_unschedulable_until`) trigger `DEL state:account:{id}` to invalidate.
- 60s TTL as a safety fallback in case a `DEL` is missed.
- Effect: hot-account state reads incur zero DB round-trips.

### 4.4 Sticky session

- **Opt-in only**: clients supply `X-Claude-Session-Id` header (Claude Code sets this per conversation).
- Lookup: `sticky:{org_id}:{session_id}` → if the account is still `schedulable` and not rate-limited → use it.
- Miss or invalid → fall through to normal selection, then `SET sticky:{org_id}:{session_id} <account_id> EX 3600` on success.
- Key prefix includes `org_id` to prevent cross-tenant collision.

### 4.5 Idempotency cache

- Client sends `X-Request-Id` header → server checks `idem:{request_id}`.
  - Hit → **replay cached response verbatim**; do not write a new `usage_logs` row; return same status code and headers.
  - Miss → normal flow; on success, cache response (non-stream) or marker (stream).
- Stream idempotency: store `{ status: "in_progress", started_at }`; duplicate request → `409 Conflict + Retry-After` (don't replay partial stream).
- `idempotency_records` table (DB) also stores request metadata for 1 hour — supports billing queries and refunds.

### 4.6 OAuth refresh concurrency control

- Multiple in-flight requests may simultaneously detect `expires_at < now() + 60s`.
- `SET oauth-refresh:{account_id} NX EX 30` — winner refreshes; losers sleep 200ms and poll until lock released.
- Winner: refresh via Anthropic token endpoint → encrypt + CAS update `credential_vault` → `DEL` lock.
- Failure: mark `account.status='error'`, increment `oauth_refresh_fail_count`, release lock, throw → triggers failover in Step 7.

### 4.7 Redis failure posture (critical architecture choice)

| Use case | Failure policy |
|---|---|
| Concurrency slots | **Fail-closed** (strict mode) → `503 service_degraded` |
| Idempotency cache | **Fail-closed** → `503 service_degraded` |
| Sticky session | **Fail-open** → proceed without sticky |
| Wait queue | **Fail-open** → reject immediately rather than wait |

Controlled via `GATEWAY_REDIS_FAILURE_MODE=strict|lenient`:
- `strict` (default) — fail-closed on slots + idempotency; recommended for billing integrity
- `lenient` — fail-open everywhere; only for dev / demo environments

### 4.8 Connection management

- Single `ioredis` client per gateway process, shared across requests
- `enableAutoPipelining: true`
- `maxRetriesPerRequest: 3`
- Reconnect events logged via pino at `warn` level

### 4.9 Observability

Prometheus metrics via `fastify-metrics` on `/metrics`:

```
gw_slot_acquire_total{scope="user|account", result="ok|over_limit|redis_error"}
gw_slot_hold_duration_seconds                    histogram
gw_wait_queue_depth                              gauge
gw_idempotency_hit_total
gw_sticky_hit_total
gw_redis_latency_seconds                         histogram {.5, .95, .99}
gw_upstream_duration_seconds                     histogram
gw_pricing_miss_total{model="..."}
gw_oauth_refresh_dead_total{account_id="..."}
gw_queue_depth                                   gauge (BullMQ wait+active)
gw_queue_dlq_count                               gauge (BullMQ failed)
```

`/metrics` endpoint scoped to gateway only — does not expose sensitive admin data.

---

## Section 5 — Async Infrastructure

Three async mechanisms: usage log pipeline, OAuth refresh, billing sanity audit.

### 5.1 Usage log pipeline (BullMQ on Redis)

Selected over in-memory channel because **gateway crash should not lose billing data**.

```
request handler
   ↓  (non-blocking enqueue, jobId = request_id for dedup)
BullMQ queue: aide:gw:usage-log
   ↓
worker pool (concurrency=4, in-process per gateway instance)
   ↓  batch: 100 rows / 1s flush interval (whichever first)
DB transaction:
  INSERT INTO usage_logs VALUES (...)                      -- append-only
  UPDATE api_keys SET quota_used_usd = quota_used_usd + ?, -- SAME txn
                      last_used_at = now()
         WHERE id = ?
```

**Design rules:**

- **Enqueue-and-return** — request handler never waits for DB insert.
- **Batch insert** — each worker invocation handles up to 100 queued jobs in a single txn.
- **Retry** — BullMQ default `attempts: 3, backoff: { type: 'exponential', delay: 1000 }`.
- **Dead letter** — after 3 failures, row written to `usage_log_failed` + pino error logged → admin surfaced via alert.
- **Billing integrity** — `usage_logs` insert and `api_keys.quota_used_usd` update in the *same* transaction. Not two-step eventually-consistent: billing cannot diverge.
- **Idempotency** — job id = `request_id`. BullMQ refuses duplicate ids — replay-safe.
- **Enqueue failure fallback** — if `queue.add()` throws (Redis timeout, BullMQ rejection), gateway executes the same INSERT + UPDATE inline in a short DB txn (see Section 3.1 Step 10). This keeps billing integrity even when Redis is in a degraded state. If the inline fallback also fails, structured error log (`gw_usage_persist_lost`) captures the full payload for manual replay; metric `gw_usage_persist_lost_total` pages on-call.

**Rate-limit window counters (5h/1d/7d) are not maintained in 4A**. Read-time on-demand aggregation:

```sql
SELECT COALESCE(SUM(total_cost), 0)
  FROM usage_logs
 WHERE api_key_id = ?
   AND created_at > now() - interval '1 day'
```

Relies on `(api_key_id, created_at DESC)` index. Before Plan 4D enforces these limits, it MUST backfill counter columns to avoid hot-path aggregation under load.

### 5.2 OAuth refresh worker (in-process cron, per-account Redis lock)

**Cron fires every 60s with per-instance jitter (`random(0, 10000)` ms applied at gateway startup).**

```
Every 60s (± per-instance jitter):
  SELECT a.id, cv.oauth_expires_at, a.oauth_refresh_fail_count, a.oauth_refresh_last_run_at
    FROM accounts a
    JOIN credential_vault cv ON cv.id = a.credential_vault_id
   WHERE a.type = 'oauth'
     AND a.schedulable = true
     AND a.deleted_at IS NULL
     AND cv.oauth_expires_at < now() + interval '10 min'

  for each row:
    -- Exponential backoff: skip if too soon after last failure
    if last_run_at IS NOT NULL AND
       last_run_at + (2 ^ fail_count) * 60s > now():
      continue

    SET aide:gw:oauth-refresh:{account_id} NX EX 30
    if lock not acquired: continue   -- another replica handling

    try:
      response = POST https://api.anthropic.com/oauth/token with refresh_token
      new_vault = { nonce, ciphertext: encrypt(response), auth_tag, oauth_expires_at: response.expires_at }
      UPDATE credential_vault SET ... WHERE id = ?  (CAS on rotated_at)
      UPDATE accounts SET oauth_refresh_fail_count = 0,
                          oauth_refresh_last_error = NULL,
                          oauth_refresh_last_run_at = now()
      DEL aide:gw:oauth-refresh:{account_id}

    catch err:
      UPDATE accounts SET oauth_refresh_fail_count = fail_count + 1,
                          oauth_refresh_last_error = err.message,
                          oauth_refresh_last_run_at = now()
      if fail_count >= GATEWAY_OAUTH_MAX_FAIL (default 3):
        UPDATE accounts SET status = 'error', schedulable = false
        emit metric gw_oauth_refresh_dead_total{account_id=...}
      DEL aide:gw:oauth-refresh:{account_id}
      pino.error(err)
```

**Why this design:**

- Every replica runs the cron independently; Redis lock ensures only one refresh per account per cycle.
- Jitter prevents thundering herd on DB + Anthropic token endpoint.
- 10-minute lead ensures inline refresh (in request handler) is rarely triggered.
- Exponential backoff prevents tight-loop on permanently-failing accounts.
- `fail_count >= 3` disables account entirely — admin must manually rotate credentials + reset the counter.

### 5.3 Pricing reload

- `pricing/litellm.json` loaded once at gateway startup into an in-memory `Map<model_name, Pricing>`.
- No hot-reload. Pricing updates flow through CI: LiteLLM upstream → weekly GitHub Action → new PR → merge → new Docker image → rolling update → pricing applied.
- Per-request lookup: O(1) map get.
- Fallback: `requested_model` not in map → `total_cost = 0`, pino warn, metric `gw_pricing_miss_total{model=...}`.

### 5.4 Billing sanity check (hourly audit)

Lightweight sampling audit, no hot-path impact.

```
Every 1h:
  sample 1% of api_keys (with LIMIT):
    expected = SELECT SUM(total_cost) FROM usage_logs WHERE api_key_id = ?
    actual   = SELECT quota_used_usd FROM api_keys WHERE id = ?
    drift    = abs(expected - actual)
    if drift > 0.01 USD:
      pino.warn with details
      emit metric gw_billing_drift_total
```

Under normal operation drift is always 0 (same-txn update). Non-zero drift indicates a code bug, DB corruption, or manual mutation — incident-level signal.

**Monotonicity check** (additional): because `usage_logs` is append-only, `expected = SUM(total_cost)` is always monotonically non-decreasing; if `actual < expected`, `quota_used_usd` must have been reset out-of-band, a logic bug, or manual mutation. The existing drift check (`actual < expected`) therefore already captures monotonicity violations — detection is automatic, no separate mechanism needed. Emit `gw_billing_monotonicity_violation_total` whenever `actual < expected` (subset of drift alerts, separate metric for easier paging).

### 5.5 Alerting thresholds

| Alert | Metric | Default threshold | Severity |
|---|---|---|---|
| Queue lag | `gw_queue_depth` | > 1000 for 5min | high |
| DLQ growth | `gw_queue_dlq_count` | > 10 in 1h | critical |
| Billing drift | `gw_billing_drift_total` | > 0.01 USD | high |
| Billing monotonicity violation | `gw_billing_monotonicity_violation_total` | any non-zero | critical |
| Pricing miss | `gw_pricing_miss_total{model=...}` | > 100/h per model | medium |
| OAuth dead | `gw_oauth_refresh_dead_total` | any non-zero | high |
| Usage enqueue fallback (frequent) | `gw_usage_enqueue_fallback_total` | > 100/min | medium |
| **Usage persist lost** (queue AND inline both failed) | `gw_usage_persist_lost_total` | any non-zero | **critical — page on-call** |

Thresholds configurable via env (`GATEWAY_ALERT_*`). Plan 4A exposes metrics only; self-host admins wire Alertmanager / Grafana themselves (documented in SELF_HOSTING.md).

### 5.6 Worker lifecycle

- All async workers run in-process on each gateway replica (not leader-elected).
- Graceful shutdown on SIGTERM:
  1. Fastify stops accepting new requests
  2. Wait for in-flight requests (timeout 30s)
  3. BullMQ worker drains remaining jobs (timeout 10s)
  4. Close Redis + Postgres pools
- SIGKILL: jobs with `attempts=3` will be reassigned by BullMQ's stalled-job detection (~30s) to another replica.

---

## Section 6 — Admin UX, API Key Distribution, Security

### 6.1 Admin UX: account management

**`/dashboard/organizations/[id]/accounts`** (requires `account.read`)

- Lists all accounts in the org, both org-scoped and team-scoped.
- Columns: name / platform / type / scope (`org` or `team: <Team Name>`) / status / last_used_at / priority
- Status badge: `active` (green) / `error` (red) / `rate-limited` (amber) / `disabled` (grey)
- Row actions: rotate credentials / edit priority & concurrency / soft-delete

**`/dashboard/organizations/[id]/accounts/new`** (requires `account.create`)

- Form fields: name / platform (4A: anthropic only) / type (`api_key` | `oauth`) / scope (org | team picker)
- `type=api_key` → paste `sk-ant-...`
- `type=oauth` → paste JSON `{"access_token", "refresh_token", "expires_at"}` (admin extracted from their own Claude Code install)
- Submit → backend encrypts via HKDF + AES-256-GCM → inserts `credential_vault` row → inserts `accounts` row (both in one txn)

**`/dashboard/organizations/[id]/teams/[tid]`** gains an `Accounts` tab showing team-overrides only.

### 6.2 Admin UX: API key management

**`/dashboard/profile`** gains an `API Keys` section for self-service (requires `api_key.issue_own`).

- List: name / key_prefix / created_at / last_used_at / status
- Actions: Revoke only (not editable — revoke and re-create for any change)

**`/dashboard/organizations/[id]/members/[uid]/api-keys`** for admin-issued keys (requires `api_key.issue_for_user`, minimum `team_manager`).

- Admins can issue keys for other members; specify ip_whitelist / quota / expires_at

**Key creation flow (the reveal):**

```
1. User clicks [Create new key]
2. Dialog: name, (optional) ip_whitelist, (optional) quota, (optional) expires_at
3. Submit
4. Response page displays the raw key **once**, with a copy button and warning:
   "This is the only time you will see the full key. Close this panel and it is gone."
5. User copies, closes the panel
6. List henceforth displays only the prefix (first 8 chars + ***...)
```

**Admin-issued keys: one-time URL flow (chosen design)**

When an admin issues a key on behalf of another user:

1. Admin submits form; backend creates `api_keys` row with hash + generates a **one-time reveal token**
2. Backend returns an opaque URL: `$BASE/api-keys/reveal/<token>` (token = 32 bytes random, stored in Redis `aide:gw:key-reveal:<token>` with EXPIRE 24h, value = `api_key_id`)
3. Admin manually delivers the URL to the target user (Slack, email, in-person)
4. Target user opens URL → page fetches raw key by token → renders reveal panel with copy button
5. After successful reveal, Redis key is DELed and DB has `revealed_at=now()` set
6. URL is single-use: second open returns "already revealed" page
7. If URL not opened within 24h, token expires; admin must re-issue

**Why one-time URL over admin-sees-once:**
- Admin never sees the plaintext (reduces inadvertent leak via screenshot / screen share)
- Target user has definitive custody on first reveal
- Easier audit trail (`revealed_at` + `revealed_by_ip`)
- UX parity with Vercel / GitHub invite-token pattern

### 6.3 Admin UX: usage query

**`/dashboard/organizations/[id]/usage`** (requires `usage.read_org`)

- Time range selector: last 24h / 7d / 30d / custom
- Stacked chart: by team or by member (tab toggle)
- Top 20 spenders table (USD)
- Per-request drill-down (will be heavily used by Plan 4B evaluator)

**`/dashboard/profile/usage`** (personal, `usage.read_own`)

- Self view: token usage, cost, TTFT, failure rate trend

### 6.4 Security: credentials encryption

**Encryption format:**

```
AES-256-GCM
master    = CREDENTIAL_ENCRYPTION_KEY   (32 bytes hex, provided via secret mount, NEVER in .env)
key       = HKDF-SHA256(
              master, 
              salt=account_id, 
              info="aide-gateway-credential-v1", 
              length=32
            )
nonce     = crypto.randomBytes(12)
plaintext = JSON.stringify(credentials)
           = {"api_key":"sk-ant-..."} 
           or {"access_token":"...","refresh_token":"...","expires_at":"2026-..."}
ciphertext, auth_tag = AES-GCM.encrypt(key, nonce, plaintext)
store (nonce, ciphertext, auth_tag) → credential_vault row
```

**What HKDF actually protects (corrected from earlier draft):**

| Protection | Provided by HKDF? | Notes |
|---|---|---|
| Memory leak of master key → partial isolation | ❌ NOT provided | HKDF is deterministic — master leak = all sub-keys derivable. Mitigate via envelope encryption + external KMS (out of 4A scope). |
| Key domain separation when master is shared across uses | ✅ via `info` parameter | E.g. same master key used for this and an unrelated system can't produce colliding sub-keys. |
| Per-account sub-key independence | ✅ via `salt=account_id` | Each account's ciphertext is encrypted with a different derived key; cross-account decryption is impossible without knowing the master. |
| Ciphertext uniqueness for the same plaintext | ❌ NOT from HKDF — **AES-GCM random nonce provides this** | The 12-byte random nonce per encryption guarantees unique ciphertext even if two accounts encrypted identical plaintext with the same sub-key. HKDF's salt is not involved. |
| Key stretching when master entropy is irregular | ✅ standard HKDF property | Useful if master is not already uniform 256-bit random. |

**Master key protection responsibility:**
- Injected via Docker secret mount or Kubernetes secret
- Never written to `.env` files, never logged, never in stack traces
- Rotated via documented procedure (Section 6.4.1); automation deferred to Plan 4D

**6.4.1 Master key rotation procedure (documented, manual for 4A):**

1. Set new key as `CREDENTIAL_ENCRYPTION_KEY_NEXT` env var
2. Run `scripts/rotate-credential-key.ts` — iterates `credential_vault` rows, decrypts with `CREDENTIAL_ENCRYPTION_KEY`, re-encrypts with `CREDENTIAL_ENCRYPTION_KEY_NEXT`, updates row
3. After all rows rotated: swap env vars (`CREDENTIAL_ENCRYPTION_KEY = NEXT`, clear `NEXT`)
4. Restart gateway
5. Manual verification: issue one test request, confirm upstream succeeds

### 6.5 Security: API key hashing (HMAC-SHA256 + pepper)

**Why HMAC-SHA256 over raw SHA-256:**

Raw SHA-256 is vulnerable to offline brute force if the `api_keys` table is dumped — attacker generates candidate keys and hashes them locally until a match is found. HMAC requires the server-side `API_KEY_HASH_PEPPER` to compute the hash, so a DB dump alone is insufficient.

**Schema / env:**

- `api_keys.key_hash` stores `HMAC-SHA256(pepper=API_KEY_HASH_PEPPER, message=raw_key)` (hex)
- `API_KEY_HASH_PEPPER` — 32 bytes hex, provided via secret mount (same posture as `CREDENTIAL_ENCRYPTION_KEY`)
- Losing the pepper = all existing api_keys become unverifiable (intentional security property: no silent compromise possible)
- Pepper is **never rotated** (rotating invalidates all keys — equivalent to a mass revoke; only done in incident response)

**Gateway auth Step 1 implementation:**

```ts
const hash = createHmac('sha256', PEPPER).update(rawKey).digest('hex')
const apiKey = await db
  .select(...).from(apiKeys)
  .where(eq(apiKeys.keyHash, hash))
  .limit(1)
```

O(1) DB index lookup, performance equivalent to SHA-256.

### 6.6 Security: IP allowlist / blocklist (at gateway layer)

In gateway Step 1, after resolving the `api_key`:

```
if apiKey.ip_whitelist IS NOT NULL AND length > 0:
  if client_ip NOT matched by any whitelist CIDR → 403 ip_not_allowed
if apiKey.ip_blacklist IS NOT NULL AND length > 0:
  if client_ip matched by any blacklist CIDR → 403 ip_blocked
```

CIDR matching via `ipaddr.js`. `X-Forwarded-For` trusted only when source IP is in `GATEWAY_TRUSTED_PROXIES` (env-configured CIDR list).

**Why gateway-layer (not api-layer):** gateway is the data plane — every request validates IP. API (admin plane) uses session cookies + RBAC, different auth model.

### 6.7 Security: auth failure rate limit

- Per-client-IP: max 10 auth failures per second
- Exceeded → temp-block for 60s (Redis key `aide:gw:authblock:{ip}`)
- Prevents brute-force scanning of api_key space

### 6.8 Security: audit log integration

All admin actions write to existing `audit_logs` table:

- `account.created` / `account.updated` / `account.rotated` / `account.deleted`
- `api_key.issued` / `api_key.revoked` / `api_key.revealed` (on one-time URL first-open)
- `credential.rotated` (master key rotation)

Each entry: `actor_user_id` = admin, `target_*` = account / api_key id, `metadata` = JSON of key change details (redacted — no plaintext credentials).

Per-request gateway audit is NOT written to `audit_logs` — the authoritative per-request record is `usage_logs` (volume too high for audit table).

---

## Section 7 — Configuration, Testing, Rollout

### 7.1 New environment variables

All new env vars validated by `packages/config/src/env.ts` zod schema (length + format checks for secrets).

| Env | Purpose | Default | Injection |
|---|---|---|---|
| `ENABLE_GATEWAY` | Feature flag (see 7.4) | `false` | env |
| `GATEWAY_PORT` | Listen port | `3002` | env |
| `GATEWAY_BASE_URL` | Public URL shown to users as API base | required | env |
| `REDIS_URL` | Shared Redis | required | env |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-256-GCM master (32 bytes hex) | required | **secret mount** |
| `API_KEY_HASH_PEPPER` | HMAC-SHA256 pepper (32 bytes hex) | required | **secret mount** |
| `UPSTREAM_ANTHROPIC_BASE_URL` | Anthropic API base | `https://api.anthropic.com` | env |
| `GATEWAY_MAX_ACCOUNT_SWITCHES` | Failover cap | `10` | env |
| `GATEWAY_MAX_BODY_BYTES` | Request body limit | `10485760` (10MB) | env |
| `GATEWAY_BUFFER_WINDOW_MS` | Smart buffer time limit | `500` | env |
| `GATEWAY_BUFFER_WINDOW_BYTES` | Smart buffer byte limit | `2048` | env |
| `GATEWAY_REDIS_FAILURE_MODE` | `strict` \| `lenient` | `strict` | env |
| `GATEWAY_IDEMPOTENCY_TTL_SEC` | Idempotency cache TTL | `300` | env |
| `GATEWAY_TRUSTED_PROXIES` | CIDRs allowed to set X-Forwarded-For | empty | env |
| `GATEWAY_OAUTH_REFRESH_LEAD_MIN` | Pre-expiry refresh lead | `10` | env |
| `GATEWAY_OAUTH_MAX_FAIL` | Refresh failure cap | `3` | env |
| `GATEWAY_QUEUE_SATURATE_THRESHOLD` | Queue lag threshold for 503 | `5000` | env |

Secrets (`CREDENTIAL_ENCRYPTION_KEY`, `API_KEY_HASH_PEPPER`) fail-fast at boot if format invalid.

### 7.2 Testing strategy

Three-layer pyramid in `apps/gateway/tests/` and `packages/gateway-core/tests/`.

**Unit (vitest, no DB/Redis/network):**

- Translation layer: 40+ fixtures covering every OpenAI↔Anthropic event pairing, snapshot tests
- Error classifier: exhaustive matrix of upstream errors → correct failover action
- Slot acquisition Lua script: `ioredis-mock`, validates concurrent behavior
- State machine: account state transitions (rate_limited → reset → schedulable)
- Pricing lookup: `resolveCost(model, tokens) → decimal` for each token type

Coverage target: `packages/gateway-core` ≥ 90% (pure logic).

**Integration (vitest + testcontainers postgres + redis):**

- Full request lifecycle: `nock` mocks Anthropic upstream → send request → verify `usage_logs` insert + `api_keys.quota_used_usd` update + Redis slot release
- Failover: first account mocked to return 429, verify gateway switches + `failed_account_ids` populated
- Mid-stream failure: upstream sends 2 SSE chunks then disconnects, verify gateway sends `event: error` + does not retry
- Concurrency: 20 concurrent requests with `account.concurrency=3`, verify slot behavior
- OAuth refresh: mock token endpoint, trigger inline refresh, verify vault row updated
- Idempotency: same `X-Request-Id` twice → second request replays cached response, no duplicate `usage_logs` row

**E2E (Playwright, UI → gateway):**

- Admin creates OAuth-type account + issues api_key (one-time URL) → uses key against gateway → verifies usage in dashboard
- Member receives one-time URL → reveals key → calls gateway → sees own record in `/profile/usage`
- IP whitelist: set `127.0.0.1` only, call from different IP → 403

### 7.3 Real-fake upstream server (streaming verification)

Beyond `nock` (which intercepts at fetch level), we maintain a real Fastify server:

**`packages/gateway-core/test/support/fake-anthropic-server.ts`**

- Fastify app listens on ephemeral port (`:0`)
- Implements `/v1/messages` with realistic shape (headers, status codes, SSE framing)
- Scenario control API:

```ts
const srv = await startFakeAnthropic()
srv.configure({
  scenario: 'stream-slow',             // 10 chunks, 100ms each
  midStreamDisconnect: 300,             // disconnect after 300ms
  onRequest: (req) => { /* assertion hook */ }
})
const baseUrl = srv.url                 // http://127.0.0.1:54321
// Integration test points gateway's UPSTREAM_ANTHROPIC_BASE_URL at this
```

**Scenarios supported:**

- `stream-normal`, `stream-slow`, `stream-fast-burst` (TCP backpressure)
- `mid-stream-tcp-reset`, `mid-stream-500`, `mid-stream-429`
- `slow-first-byte` (TTFT metric verification)
- `chunked-encoding-edge-cases` (trailing CRLF, empty chunks)

**Why real server beyond nock:**

- `nock` intercepts at the Node fetch layer; undici's actual TCP / HTTP/1.1 / SSE framing code is not exercised
- Required for validating: `AbortSignal` propagation closing upstream TCP; SSE parser resuming on partial chunks; smart-buffer 500ms timing behavior
- `nock` retained for fast unit tests (no server startup, millisecond-level) — good for the large error-classification matrix

### 7.4 Feature flag rollout (multi-layer gating)

`ENABLE_GATEWAY=false` by default. Multiple gates:

| Layer | Mechanism |
|---|---|
| **Primary** (orchestration) | `docker-compose.yml` uses `profiles: [gateway]`; k8s Deployment template defaults to `replicas: 0`. Gateway service never starts in default deploys. |
| **Secondary** (gateway process) | On startup, if `ENABLE_GATEWAY=false`: do NOT register `/v1/*` routes; serve only `/health` (returns `{"status":"disabled"}`); emit warn log. **Do not call `process.exit(0)`** — would cause restart loop under orchestration. |
| **Tertiary** (API tRPC) | `accounts.*`, `apiKeys.*`, `usage.*` routers throw `TRPCError({ code: 'NOT_FOUND' })` when flag is false. |
| **Quaternary** (Web UI) | Dashboard pages and nav entries conditionally hidden. |

Defense-in-depth: UI hide is cosmetic; API + process gates are the actual protection.

### 7.5 Migration & rollout

**Migration order:**

1. New migration `0005_gateway_schema.sql` — create 4 new tables + indexes + RBAC action enum additions
2. Backfill: none (all new tables, existing data untouched)
3. Deploy: roll web + api first, then gateway; gateway failure does not affect existing web/api
4. Smoke: run `scripts/smoke-gateway.sh` — `curl /health`, `curl /metrics`, create a test account + key, call `/v1/messages`

**Schema change policy (enforced going forward):**

- ✅ Allowed: new tables, new nullable columns, new indexes, new CHECK constraints with `NOT VALID` first
- ❌ Forbidden in 4A: modifying existing enum (adding new value) — old ORM / zod validators will crash on unrecognized value. If new enum value needed, use a new column or a text column + CHECK constraint instead.
- ❌ Forbidden in 4A: modifying column type or nullability — old readers will error at runtime.
- This policy written into `docs/GATEWAY.md#schema-change-policy`; subsequent plans must comply.

### 7.6 CI + release

- `ci.yml` adds job `gateway-integration`: starts testcontainers postgres + redis, runs `pnpm -F @aide/gateway test:integration`
- `release.yml` matrix adds `gateway`: builds and pushes `ghcr.io/hanfour/aide-gateway:{tag,latest}`, multi-arch `linux/amd64,linux/arm64` (reuses the PR #3 `docker/setup-qemu-action` + `platforms` setup)
- `docker-compose.yml` adds `gateway` + `redis` under `profiles: [gateway]`
- `.env.example` documents all new env vars
- `SELF_HOSTING.md` adds a "Gateway + Redis" setup section

### 7.7 Documentation

- **NEW `docs/GATEWAY.md`** — architecture, account management, api_key distribution, client usage examples (Anthropic-native + OpenAI-compat), troubleshooting runbook
- **NEW `apps/gateway/README.md`** — dev startup, test harness usage, debugging tips

---

## Section 8 — Operations / SLO / Runbook

### 8.1 SLO targets (tiered)

| Tier | Deployment | Availability | Note |
|---|---|---|---|
| **Baseline** | self-host, single replica | **99.0%** (30d rolling) | 4A ship-level expectation |
| **Aspirational** | multi-replica, HA Redis + HA Postgres | **99.5%** (30d rolling) | Target once operational maturity is proven |

Additional SLOs:

- **Request success rate ≥ 95%** — 1h rolling; **excludes Anthropic upstream outage windows** (denominator subtracts)
- **TTFT p95 < 2s** — 1h rolling; **end-to-end (includes upstream)**; upstream outage windows excluded
- **Async usage log lag p95 < 5s** — enqueue-to-DB-write

SLO breach is not a hard break; it triggers Alertmanager → incident response.

### 8.2 Failure posture matrix

| Dependency / event | Gateway behavior | Rationale |
|---|---|---|
| Postgres down | **Fail-closed** → `503 database_unavailable` | No DB → no auth → cannot proceed |
| Redis down (strict mode) | **Fail-closed** → `503 service_degraded` | Billing integrity |
| Redis down (lenient mode) | **Fail-open** → degrade (no concurrency slot, no idempotency) | Admin explicitly opted in |
| Anthropic upstream (single account) | **Failover** → switch account | Normal degrade path |
| Anthropic upstream (all org accounts failed) | `503 all_upstreams_failed` | No remaining path |
| LiteLLM pricing miss | **Fail-open** → `total_cost=0` + metric + warn log | Don't block service over pricing gap |
| **Gateway process crash / Node OOM** | Instance dies → orchestrator restarts; BullMQ stalled-job detection (~30s) reassigns jobs to other replicas | Inherent risk of in-process worker model; mitigated by BullMQ recovery |
| **Secret missing / invalid** | **Fail-fast at boot** (zod validation rejects bad `CREDENTIAL_ENCRYPTION_KEY` / `API_KEY_HASH_PEPPER` length / hex format); `process.exit(1)` with clear log | Misconfigured gateway never accepts traffic |
| **Usage queue backlog saturation** (Redis OK but queue lag spike) | Strict mode: `503 service_degraded`, stop accepting new billing-incurring requests until lag drops. Lenient mode: accept with warn log. | Prevents unbounded in-memory queue growth; triggered by `bullmq_wait_count + active_count > GATEWAY_QUEUE_SATURATE_THRESHOLD` (default 5000) |
| **Credential decrypt failure** (single account) | Mark that account `status='error'`, `error_message='decrypt failed'`, `schedulable=false`; **gateway stays up**; failover to other accounts | Isolate one bad row from taking down the whole gateway |

### 8.3 Runbook (self-host admin, 7 common scenarios)

Documented in `docs/GATEWAY.md#runbook`.

1. **Gateway returns `503 service_degraded`** — Check Redis connection (`redis-cli ping`); restart Redis or switch to `lenient` mode temporarily.

2. **All requests return `all_upstreams_failed`** — Inspect `accounts` table `status` / `error_message`; if `rate_limited_at` futures are all populated, likely Anthropic regional outage. Check Anthropic status page.

3. **OAuth refresh failing repeatedly** — Check `accounts.oauth_refresh_last_error` + `oauth_refresh_fail_count`. Common causes: refresh_token invalidated by Anthropic (re-auth required); outbound network blocked by firewall.

4. **Billing drift alert** — Run `scripts/reconcile-billing.ts` (provided in 4A). Compares `usage_logs.SUM(total_cost)` vs `api_keys.quota_used_usd`. If drift is real: use `usage_logs` as source of truth, correct `api_keys` via script; file incident.

5. **Gateway latency high** — Examine `gw_redis_latency_seconds` (Redis bottleneck → scale or investigate slow commands) and `gw_upstream_duration_seconds` (upstream slow → check Anthropic status, consider additional accounts).

6. **Deploy → all API key auth suddenly fails** — Most common cause: `API_KEY_HASH_PEPPER` not injected, injected with wrong value, or secret mount permissions broken. Verify: `echo -n "known_test_key" | openssl dgst -sha256 -hmac "$API_KEY_HASH_PEPPER"` matches a DB row. If pepper is lost: no recovery (by design) — must reissue all api_keys org-wide.

7. **Queue lag / DLQ growth** — Check `gw_queue_depth` + `gw_queue_dlq_count`. DB latency high → inspect `pg_stat_statements`, usually `usage_logs` insert slowdown (index bloat, disk I/O). Redis latency high → BullMQ contention. Worker logic broken → inspect DLQ `failedReason`, commonly FK violations from orphaned rows.

### 8.4 Rollback

Plan 4A is additive to v0.2.0 schema. Rollback path:

1. Roll `apps/web` + `apps/api` back to v0.2.0 (old versions ignore new tables and new tRPC routers without error)
2. Stop `apps/gateway` containers
3. **Do not run down-migration**: leave the 4 new tables intact; older versions don't touch them
4. Optional: `redis-cli KEYS 'aide:gw:*' | xargs redis-cli DEL` (clean Redis state)

Data preservation:
- `usage_logs` retained → Plan 4B launches with historical data already available
- `credential_vault` retained → credentials survive for next rollout

**Rollback constraint (from 7.5 policy):**
- Rollback safe **only if** schema changes are additive. Breaking changes (enum additions to existing enums, nullability changes, type changes) are forbidden in 4A specifically because they would break old versions reading the new schema. The policy applies to every subsequent plan.

### 8.5 Feature flag gating note (corrected from draft)

`ENABLE_GATEWAY=false` is enforced by multiple layers (see 7.4). **`process.exit(0)` is NOT used as primary gating** — under container orchestration it causes restart loops. Primary gating is orchestration-level (compose profile / k8s replicas); process-level gating only skips route registration and serves a minimal `/health` endpoint returning `{"status":"disabled"}`.

---

## Decision Log (consolidated)

Every decision the user approved during brainstorming:

| # | Area | Decision | Source |
|---|---|---|---|
| 1 | Account scope | Org-scoped default + team-override (`(org_id, team_id nullable)` two-column FK) | User choice C |
| 2 | API surface | Anthropic native (`/v1/messages`) + OpenAI-compat (`/v1/chat/completions`) from day 1 | User choice B |
| 3 | Gateway hosting | Separate `apps/gateway` Fastify service (port 3002) | User choice B |
| 4 | Credentials | `api_key` + `oauth` both implemented in 4A runtime; HKDF-derived per-account sub-keys; AES-256-GCM | User choice B |
| 5 | Architecture internal | Architecture 2 — full sub2api-level: worker pool + Redis concurrency + failover + wait queue | User choice |
| 6 | Redis reliance | Redis is a hard dependency; `GATEWAY_REDIS_FAILURE_MODE=strict` default (fail-closed on billing-critical paths) | User approval |
| 7 | Schema isolation | `credential_vault` in its own table; `usage_logs` `bigserial` PK; FK RESTRICT for user/api_key/account/org; SET NULL for team | User approval |
| 8 | Failover cap | 10 cross-account switches (match sub2api); 3 × 500ms same-account retries | User directive (quality > complexity) |
| 9 | Mid-stream failure | Smart buffering window (novel): first 500ms / 2KB buffered before flush; errors in window → transparent failover | User directive (quality edge) |
| 10 | OpenAI tool_calls | Incremental emit (chunk-by-chunk) matching OpenAI protocol precisely | User directive (quality > complexity) |
| 11 | Usage log queue | BullMQ on Redis (durable, crash-safe) | User choice |
| 12 | Billing integrity | `usage_logs` insert + `api_keys.quota_used_usd` update in SAME txn | User directive |
| 13 | Rate-limit counters | 4A skip; **Plan 4D MUST backfill before enforcing** | User approval |
| 14 | OAuth refresh | 60s cron cadence with per-instance jitter + 10min lead time + `oauth_refresh_fail_count` + exponential backoff | User refinement |
| 15 | Alerting | Billing drift + monotonicity violation + queue lag + DLQ + pricing miss + OAuth dead | User additions |
| 16 | Admin UX | 3 page groups (accounts / api-keys / usage); self-service + admin-on-behalf | User approval |
| 17 | API key reveal | One-time URL (24h expiry, single-use, audit-logged) | User choice B |
| 18 | HKDF narrative | Corrected: HKDF provides **key domain separation** (`info`) and **per-account sub-key independence** (`salt=account_id`). It does NOT protect against master key leak, and it does NOT provide ciphertext uniqueness (that comes from the AES-GCM random nonce, not from HKDF). | User correction |
| 19 | API key hashing | HMAC-SHA256 with `API_KEY_HASH_PEPPER` (not raw SHA-256) | User correction |
| 20 | IP allowlist | At gateway layer (data plane) | User approval |
| 21 | Testing | Three-layer pyramid + real fake Anthropic server for streaming verification (not just nock) | User refinement |
| 22 | Feature flag | Multi-layer gating (orchestration primary + process + API + UI); NO `process.exit(0)` as primary gate | User correction |
| 23 | Release matrix | Gateway must be in `release.yml` matrix with multi-arch | User directive |
| 24 | SLO | Baseline 99.0% (self-host single-replica); aspirational 99.5% (multi-replica HA) | User refinement |
| 25 | Failure matrix additions | Process crash/OOM, secret misconfig, queue saturation, decrypt failure | User additions |
| 26 | Runbook additions | Deploy→all keys fail (pepper), queue lag spike | User additions |
| 27 | Rollback | Stop service, keep schema; require additive-only schema changes | User approval |

---

## Open questions for Plan 4A → writing-plans handoff

Before invoking `superpowers:writing-plans` to break 4A into tasks:

1. **Task decomposition granularity** — Plan 3 ran 25 tasks over ~1 week. 4A has similar scope; expect ~30-35 tasks across schema, gateway runtime, api admin, web UI, tests, infra.
2. **Implementation ordering** — Preferred order (user confirms or adjusts):
   - Part 1: Schema + migration + RBAC actions (no runtime)
   - Part 2: `packages/gateway-core` pure utilities (pricing, translation, state machine) — all unit-testable
   - Part 3: `apps/gateway` scaffolding + auth middleware + `/health` + `/metrics`
   - Part 4: Redis layer (slots, wait queue, idempotency, sticky)
   - Part 5: Account selection + credential decrypt + upstream passthrough (non-stream)
   - Part 6: Streaming + smart buffer window + OpenAI-compat translation **+ failover state machine + OAuth refresh worker** (merged — buffer window semantics are tightly coupled with failover; splitting yielded incoherent task boundaries)
   - Part 7: Usage log worker (BullMQ) + billing txn + inline fallback
   - Part 8: `apps/api` admin tRPC routers (accounts, apiKeys, usage)
   - Part 9: `apps/web` admin UI (accounts, keys, usage pages + one-time URL reveal)
   - Part 10: Docker + compose + release.yml + CI integration job
   - Part 11: Documentation (GATEWAY.md, SELF_HOSTING.md update)
   - Part 12: E2E + smoke
   - Part 13: Tag v0.3.0 (isolated — release gate runs only after 1–12 all green)
3. **Scope confirmation** — is the "quality > complexity" stance still active? All decisions were made under that directive; if budget shifts, some items (smart buffer, incremental tool_calls, OAuth in 4A) could be dropped back to Plan 4C.

---

*End of Plan 4A design document.*









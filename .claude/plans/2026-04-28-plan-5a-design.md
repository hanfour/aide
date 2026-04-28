# Plan 5A — OpenAI Provider (subscription-pool first, API key fallback)

**Date:** 2026-04-28
**Status:** Sub-design (also serves as Plan 5 framework — see §0)
**Scope:** OpenAI as a peer upstream provider, OAuth subscription pool + sk-key fallback, three client routes, Group concept introduction
**Target release:** v0.6.0 (5A) — v0.5.0 will tag with current main (post-4C); 5A is the first feature wave after 5B closeout
**Predecessor on main:** 4C (Plan 4C 18 parts + 6 follow-ups merged at `ab421e0`)
**Reference architecture:** [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) — production-validated multi-provider gateway with same goals

---

## 0. Plan 5 framework (cross-cutting)

This section is the de-facto Plan 5 main design. Subsequent phase docs (5B Gemini, 5C Antigravity, 5D Anthropic OAuth refactor) reference it for shared decisions.

### 0.1 Background — actual user goal

Internal R&D team uses three AI coding assistants:
- **Claude Code** — already pooled via Claude Pro/Max OAuth bundles (4A delivered)
- **Codex CLI / ChatGPT subscription** — needs pooling
- **Gemini CLI / Gemini Advanced** — needs pooling

User priority: **company-paid subscription quotas pooled across team first, fall back to per-call API keys after subscription quota exhausted**. Same model as 4A's Anthropic OAuth bundle, extended to OpenAI + Gemini.

Out of scope (per origin handoff line 58–60): payment systems, iframe embedding, public Sub2API platform features. ai-dev-eval remains an internal team tool.

### 0.2 sub2api borrowable architecture (verified by source reading)

11 patterns confirmed in `/tmp/aide-research/sub2api` source (commit at clone time):

1. **4-platform × 2-type model** — `(anthropic | openai | gemini | antigravity) × (oauth | apikey)` — sub2api `internal/domain/constants.go:21-32`
2. **Group concept = routing unit** — `api_keys.group_id → groups.platform`; routing static-bound per-API-key, not per-request — `internal/server/routes/gateway.go:44-50`
3. **3-layer scheduler** — `previous_response_id` → `session_hash` → `load_balance` (EWMA error + TTFT) — `internal/service/openai_account_scheduler.go:242-310`
4. **Per-platform 4-piece** — `OAuthService + TokenProvider + TokenRefresher + RefreshPolicy` — `internal/service/wire.go:55-130`
5. **Unified `OAuthRefreshAPI` lock arbitration** — eliminates race between background refresh + on-demand refresh — `wire.go:42-46`
6. **Per-platform RefreshPolicy** — Anthropic/OpenAI tolerant (use existing token on failure, 1min TTL); Gemini/Antigravity strict (return error, 0 TTL) — `internal/service/refresh_policy.go`
7. **Vendored OAuth client_ids from official CLIs** — OpenAI `app_EMoamEEZ73f0CkXaXp7hrann` (Codex CLI), Gemini `681255809395-...` (Google's Gemini CLI), Antigravity `1071006060591-...` — `internal/pkg/openai/oauth.go:19`, `internal/pkg/geminicli/constants.go:41`
8. **ImpersonateChrome only on subscription metadata fetch** — TLS fingerprint impersonation used to call `chatgpt.com/backend-api` for `plan_type` and quota; NOT in inference hot path — `internal/service/openai_oauth_service.go:20`
9. **Three URL spaces with auto-route by group platform** — `/v1/messages`, `/v1/chat/completions` + `/v1/responses`, `/v1beta/*`; handler dispatches on `group.platform` — `internal/server/routes/gateway.go:44-115`
10. **usage_logs 4 token classes + 2-stage cost** — `input/output/cache_creation/cache_read` plus `cache_creation_5m/cache_creation_1h` for Anthropic prompt cache; `total_cost` (raw) + `actual_cost` (after `rate_multiplier`) — `migrations/001_init.sql usage_logs`
11. **Quota tracking is platform-specific** — Antigravity has `QuotaFetcher` interface; Gemini uses tier policy table; OpenAI fetches `plan_type` from `chatgpt.com/backend-api` via ImpersonateChrome; Anthropic relies on 429 → `temp_unschedulable_until` — `internal/service/quota_fetcher.go` + `gemini_quota.go` + `openai_oauth_service.go:32`

### 0.3 What ai-dev-eval ports directly vs adapts

| Pattern | sub2api source | ai-dev-eval action | Reason |
|---|---|---|---|
| 4-platform constants | `domain/constants.go` | **Direct port** — extend existing `upstream_accounts.platform` text column to allow `openai/gemini/antigravity` values | Already a text column (4A); just expand allowed Zod enum |
| Group concept | `groups` + `api_keys.group_id` | **New port** — introduce `account_groups` table; bind via `api_keys.group_id` | 4A doesn't have this; biggest architectural shift |
| `(platform, type)` tuple | `accounts(platform, type)` | **Already aligned** — 4A `upstream_accounts(platform, type)` matches | No migration needed for shape; only enum values |
| 3-layer scheduler | `openai_account_scheduler.go` | **Adapted port** — current 4A `failoverLoop` is single-layer; refactor to 3 layers | Current ai-dev-eval has no sticky session concept; this is also a major shift |
| 4-piece OAuth pattern | `wire.go:55-130` | **Direct port** — split current `oauthRefresh.ts` into `OAuthService/TokenProvider/TokenRefresher/RefreshPolicy` per platform | 4A's monolithic `oauthRefresh.ts` is anthropic-hardcoded |
| Vendored client_ids | `pkg/openai/oauth.go:19` etc. | **Direct port** — copy the exact client_id constants | Public knowledge; same ones any user of those CLIs already has |
| ImpersonateChrome | `pkg/httpclient/req_client_pool.go` | **Adapted port** — Node has no native equivalent; use `node-tls-fingerprint` lib OR call out to a small Go binary; document risk | Required for OpenAI `plan_type` fetch; if we skip we lose quota visibility but core inference works |
| RefreshPolicy table | `refresh_policy.go` | **Direct port** — same matrix (tolerant vs strict) | Behaviour is platform-intrinsic; no reason to differ |
| 3 URL spaces auto-route | `routes/gateway.go` | **Adapted port** — ai-dev-eval already has `/v1/messages` + `/v1/chat/completions` + `/v1/responses` (5A new); add group-platform dispatch | Existing routes stay; add dispatch logic |
| usage_logs 4 token + actual_cost | `migrations/001_init.sql usage_logs` | **Adapted port** — current ai-dev-eval `llm_usage_events` lacks cache_5m/1h split + rate_multiplier two-stage; extend in migration 0008 | Need backwards compatibility with 4C cost ledger |
| QuotaFetcher per platform | `service/quota_fetcher.go` | **Direct port** — new `QuotaFetcher` interface + per-platform impls | New concept entirely |
| Group rate_multiplier | `groups.rate_multiplier` | **Direct port** — part of new `account_groups` table | Cost adjustment knob |
| Antigravity (Google OAuth + dual-model dispatch) | `internal/pkg/antigravity/` | **Defer to 5C** — not in 5A scope | Antigravity is its own platform |

**Not ported** (not relevant or wrong fit):
- sub2api's payment system (out of scope per user)
- sub2api's `affiliate` / `redeem_code` (consumer features)
- sub2api's `OPSDashboard` complexity (4C already has Grafana)
- sub2api's ImpersonateChrome for inference path (we don't need it; sub2api uses it for some failover edge cases we don't have)

### 0.4 4-phase plan ordering (Plan 5)

| Phase | Scope | Why this order |
|---|---|---|
| **5A** | OpenAI provider (OAuth ChatGPT subscription + sk-key) + Group concept introduction + 3-layer scheduler refactor + 4-piece OAuth pattern | OpenAI is the most-needed addition; introducing Group + scheduler refactor here pays the dirty work cost once |
| **5B** | Gemini provider (Code Assist + AI Studio OAuth + Gemini API key) | Reuses 5A's group + scheduler; just adds platform |
| **5C** | Antigravity provider (Google OAuth → dual-model Claude+Gemini dispatch) | Optional; reuses 5B's Google OAuth machinery |
| **5D** | Anthropic OAuth refactor — port 4A's anthropic OAuth into the 4-piece pattern | Last because 4A's monolith currently works; refactor is ergonomic improvement |

### 0.5 Cross-cutting decisions (apply to 5A–5D)

| # | Decision | Rationale | sub2api evidence |
|---|---|---|---|
| X1 | `upstream_accounts.platform` stays text + Zod enum (do NOT use pgEnum) | Matches 4B/4C convention (decision D3 in 4B); enum migration cost not worth it for closed set of 4 | sub2api also uses `VARCHAR(50)` not enum (`migrations/001_init.sql:5`) |
| X2 | Group concept introduced as **new** `account_groups` table linking `api_keys` to a set of `upstream_accounts` (each group = one platform) | Routing dispatch needs static binding; per-request alias resolution is too dynamic for sub2api's pattern | `groups` + `account_groups` + `api_keys.group_id` |
| X3 | 4-piece OAuth pattern (`OAuthService + TokenProvider + TokenRefresher + RefreshPolicy`) per platform | Race-free hot-path token cache; per-platform refresh tunables | `wire.go:55-130` |
| X4 | Per-platform RefreshPolicy with documented matrix (Anthropic/OpenAI tolerant; Gemini strict) | Empirically discovered; do not deviate without reason | `refresh_policy.go` |
| X5 | OAuth client_ids vendored from upstream CLIs (constants in code, PR-reviewed at vendor time) | Public knowledge; same ID OpenAI/Google's CLI users send | `pkg/openai/oauth.go:19` |
| X6 | 3-layer scheduler: `previous_response_id` → `session_hash` → `load_balance` (EWMA error + TTFT) | Plug-and-play matches Codex CLI / Claude Code conversation continuity expectations | `openai_account_scheduler.go:242-310` |
| X7 | Failover scoped to same `(platform, type-agnostic-within-platform)` only; cross-platform via group routing only | Model behaviour expectations; cross-platform inside one request is unsafe | (Origin handoff agreement) |
| X8 | usage_logs schema gains 4 token classes + cache_5m/1h split + `total_cost` + `actual_cost` (rate_multiplier applied) | Anthropic prompt cache pricing requires the split; group-level billing requires the two-stage cost | `usage_logs` columns |
| X9 | Per-platform `QuotaFetcher` interface; OpenAI uses ImpersonateChrome to call `chatgpt.com/backend-api` for `plan_type`; Anthropic continues to use 429 → temp_unschedulable | Each provider exposes quota info differently | `quota_fetcher.go` interface |
| X10 | ImpersonateChrome dependency: ship only when needed for OpenAI quota fetch; not on inference hot path | Avoids TLS fingerprint maintenance burden on the critical path | sub2api `openai_oauth_service.go:20` comment |
| X11 | Cost ledger event suffix: OAuth = `_subscription` (cost_usd=0 against budget; subscription is sunk cost); API key = priced via `model_pricing` lookup | Subscription costs don't double-bill; budget enforcement only on metered API key calls | (Plan 5 design original; matches 4C Phase 1 ledger pattern) |
| X12 | Sub-design split: 5A self-contained with §0 framework; 5B/5C/5D each focus on platform-specific deltas; no separate "main design" doc | Reduces doc count; each phase is reviewable as self-contained | (this design's own choice) |

### 0.6 Schema migration plan (across Plan 5)

| Migration | Phase | Content |
|---|---|---|
| **0008** | 5A | `account_groups` table + `api_keys.group_id` column + `upstream_accounts.subscription_tier` text |
| **0009** | 5A | `model_pricing` table + seed (Anthropic + OpenAI, snapshot 2026-04-28) |
| **0010** | 5A | `usage_logs` extension (cache_5m/1h split, actual_cost) — additive |
| 0011 | 5B | Gemini-specific quota tier table + seed |
| 0012 | 5C | Antigravity-specific tables (if needed) |
| 0013 | 5D | (refactor only; no schema changes expected) |

---

## 1. Context (5A-specific)

### 1.1 Current state of ai-dev-eval

- Main: `ab421e0` (Plan 4C 18 parts + 6 follow-ups merged)
- Migrations through 0007 (platform rubric v2)
- `upstream_accounts.platform` is `text` column, currently only stores `"anthropic"`
- `upstream_accounts.type` is `text` column, values include `"oauth"` and `"apikey"`
- `oauthRefresh.ts` is anthropic-hardcoded (`apps/gateway/src/runtime/oauthRefresh.ts:14-15`)
- 3 client routes exist: `/v1/messages` (4A), `/v1/chat/completions` (4A; OpenAI-format → translate → Anthropic upstream), `/v1/responses` (does NOT exist; 5A introduces)
- `failoverLoop.ts` is single-layer (priority + last_used_at sort); no sticky session concept
- `llm_usage_events` (4C Phase 1) lacks cache_5m/1h split and `actual_cost`

### 1.2 What 5A delivers

- New OpenAI platform support, both `oauth` and `apikey` account types
- New `account_groups` table; existing `upstream_accounts` now belong to groups
- `api_keys.group_id` foreign key; routing dispatch on `group.platform`
- 3-layer scheduler refactor (replaces single-layer `failoverLoop`)
- 4-piece OAuth pattern (`OAuthService`, `TokenProvider`, `TokenRefresher`, `RefreshPolicy`) for OpenAI; Anthropic stays on existing monolithic `oauthRefresh.ts` until 5D refactor
- `model_pricing` DB-backed table replaces 4C constants
- `usage_logs` cache_5m/1h split + `actual_cost` two-stage billing
- `/v1/responses` route + Codex CLI compatibility test
- Body + stream translators for `(anthropic, chat, responses)` cross-format paths
- ImpersonateChrome dependency for OpenAI subscription `plan_type` fetch (admin metadata, not inference)

### 1.3 What 5A defers (to 5B/5C/5D)

- Gemini provider (5B)
- Antigravity provider (5C)
- Anthropic OAuth refactor into 4-piece (5D)
- Cross-platform routing via aliases (out of Plan 5 entirely; aligns with X7)
- Per-account quota visibility for Anthropic (no quota API; relies on 429 already)

---

## 2. Goals + non-goals

### Goals

1. **OpenAI ChatGPT subscription pooling works** — admin pairs ChatGPT Plus/Pro/Enterprise via Codex CLI OAuth flow; gateway uses refreshed tokens for upstream calls; multiple subscriptions in one group split traffic
2. **OpenAI sk-key fallback works** — same group can mix OAuth subscription accounts + sk-key accounts; failover spans them (decision X7)
3. **Group routing is the user-visible primitive** — admin creates a group "openai-pool", adds OAuth + sk-key accounts, issues an API key bound to the group; clients hit any of three URL spaces; gateway picks accounts from that group only
4. **Three client routes work end-to-end** — `/v1/messages` (Anthropic format → OpenAI upstream via translation when group platform = openai), `/v1/chat/completions` (passthrough or translated), `/v1/responses` (Codex CLI's native protocol)
5. **3-layer scheduler matches sub2api semantics** — Codex CLI multi-turn correctly sticky to one upstream account
6. **Cost ledger shows OAuth as `$0 (subscription)` and sk-key as priced** — admin sees true subscription utilisation + metered fallback spend
7. **Plan_type display from ChatGPT subscription** — ImpersonateChrome fetches `chatgpt.com/backend-api/me`; admin sees Plus/Pro/Enterprise tier per OAuth account

### Non-goals (explicitly out of 5A)

- Gemini provider (5B)
- Antigravity provider (5C)
- Anthropic OAuth refactor into 4-piece pattern (5D — current monolith continues to work for 5A)
- Cross-platform routing inside one request (X7)
- WebSocket variant of `/v1/responses` (sub2api has it; we defer)
- OpenAI Realtime API (`gpt-4o-realtime`)
- OpenAI Assistants API (`/v1/assistants/*`)
- File / image / audio token classes (text only in 5A)
- Per-org pricing override (admin can view, not customize)
- ImpersonateChrome for inference path (only metadata fetch)
- Public payment / SaaS Sub2API features

---

## 3. Decision log (5A-specific)

Cross-cutting decisions X1–X12 are in §0.5. Below are 5A-specific:

| # | Decision | Rationale |
|---|----------|-----------|
| A1 | OpenAI OAuth `client_id = app_EMoamEEZ73f0CkXaXp7hrann` (vendored from Codex CLI source) | Direct port from sub2api `pkg/openai/oauth.go:19`; same client any Codex CLI user sends |
| A2 | OAuth redirect URI = `http://localhost:1455/auth/callback` | Loopback; same port as sub2api; no public callback needed |
| A3 | PKCE method = S256 | Standard; matches sub2api |
| A4 | OpenAI access token TTL ≈ 1 hour; refresh token ≈ 30 days; rotation supported (replace stored if response includes new refresh_token) | Decoded from observation in sub2api; impl must handle rotation atomically (single SQL UPDATE) |
| A5 | Refresh fail handling per X4: tolerant — use existing token if refresh fails (1min FailureTTL before retry) | Per sub2api `OpenAIProviderRefreshPolicy()`; aligns with Anthropic policy |
| A6 | `/v1/responses` route Zod schema = text + function-calling subset only | sub2api supports more (file_search, code_interpreter); we explicitly reject those with `400 unsupported_feature` |
| A7 | Streaming SSE event mapping uses recorded fixtures from real upstream (one-off capture, committed) | Snapshot-test pattern; matches sub2api test approach |
| A8 | ImpersonateChrome lib choice: `node-tls-fingerprint` (npm) on Node side; OR small Go sidecar binary called via stdio | Decide at impl time; npm option is lower-risk; sidecar gives more control |
| A9 | Plan_type fetch is opt-in per account creation (admin can skip — accounts work without it; only quota visibility lost) | ImpersonateChrome dependency is not blocking; degrades gracefully |
| A10 | 3-layer scheduler refactor lands in 5A (not deferred) — replaces existing `failoverLoop.ts` for ALL platforms | Current single-layer is fine for Anthropic but 5A adds Codex CLI which strictly needs `previous_response_id` sticky |
| A11 | Existing 4A Anthropic accounts continue to work without migration; new `account_groups` table accepts existing `upstream_accounts` rows; admin assigns groups post-migration | Backwards compat for production accounts |
| A12 | Sticky session storage: Redis with TTL (matches sub2api); key = `sticky:openai:<group_id>:<session_hash> → account_id` | Redis already in 4A stack |
| A13 | EWMA for load balance scoring uses existing 4A's runtime stats infrastructure (extend if needed) | Reuse don't reinvent |
| A14 | `account_groups` is a join table (`account_id`, `group_id`, `priority`); same account can belong to multiple groups | sub2api pattern — see `migrations/001_init.sql account_groups` |
| A15 | API key creation requires picking exactly one group; group's platform fixes which routes work for that key | Matches sub2api auth middleware pattern |
| A16 | Existing 4A API keys (no group_id) auto-migrate to a default `legacy-anthropic` group containing all current anthropic accounts | Migration safety; admin can re-organise after |
| A17 | Body + stream translators reuse 4A's existing `gateway-core` package; new translators added there (not in `apps/gateway`) | Maintain package responsibility boundary |
| A18 | OpenAI cost mapping uses `model_pricing` table for sk-key accounts; OAuth accounts always log `cost_usd = 0` with `event_type` suffix `_subscription` (X11) | Subscription is sunk cost; ledger row written for visibility |
| A19 | Failover loop's `pickNextAccount` filters by `provider_kind = group.platform` AND `(account.id IN group)` | Group-scoped failover; respects platform binding |
| A20 | Routes coexist under `/v1` (no separate prefix); auto-route dispatch by group platform per X9. ALSO add `/backend-api/codex/responses` as Codex CLI compatibility alias (Codex CLI hits this path natively) | Per sub2api `routes/gateway.go:143-149`; Codex CLI sends requests to ChatGPT-compatible URL by default |

---

## 4. Schema changes

### 4.1 Migration 0008 — `account_groups` + `api_keys.group_id` + `subscription_tier`

```sql
-- Up

-- 4.1.1 New table: account_groups
CREATE TABLE account_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  platform TEXT NOT NULL,
  rate_multiplier DECIMAL(10, 4) NOT NULL DEFAULT 1.0,
  is_exclusive BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT account_groups_platform_values
    CHECK (platform IN ('anthropic', 'openai', 'gemini', 'antigravity')),
  CONSTRAINT account_groups_status_values
    CHECK (status IN ('active', 'disabled')),
  CONSTRAINT account_groups_org_name_unique
    UNIQUE (org_id, name)
);

CREATE INDEX account_groups_org_platform_idx
  ON account_groups (org_id, platform)
  WHERE deleted_at IS NULL;

-- 4.1.2 New join table: account_group_members (many-to-many)
CREATE TABLE account_group_members (
  account_id UUID NOT NULL REFERENCES upstream_accounts(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES account_groups(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 50,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, group_id)
);

CREATE INDEX account_group_members_group_priority_idx
  ON account_group_members (group_id, priority);

-- 4.1.3 Extend api_keys with group_id
ALTER TABLE api_keys
  ADD COLUMN group_id UUID REFERENCES account_groups(id) ON DELETE SET NULL;

CREATE INDEX api_keys_group_idx ON api_keys (group_id) WHERE deleted_at IS NULL;

-- 4.1.4 Extend upstream_accounts with subscription_tier
ALTER TABLE upstream_accounts
  ADD COLUMN subscription_tier TEXT;

ALTER TABLE upstream_accounts
  ADD CONSTRAINT subscription_tier_values
  CHECK (
    subscription_tier IS NULL
    OR subscription_tier IN ('free', 'plus', 'pro', 'team', 'enterprise')
  );

-- 4.1.5 Backfill: create legacy-anthropic group + migrate existing accounts + api_keys
DO $$
DECLARE
  v_org_id UUID;
  v_group_id UUID;
BEGIN
  FOR v_org_id IN SELECT DISTINCT org_id FROM upstream_accounts WHERE platform = 'anthropic' AND deleted_at IS NULL
  LOOP
    INSERT INTO account_groups (org_id, name, platform, description)
    VALUES (v_org_id, 'legacy-anthropic', 'anthropic', 'Auto-created during 5A migration; reorganise in admin UI')
    RETURNING id INTO v_group_id;

    INSERT INTO account_group_members (account_id, group_id, priority)
    SELECT id, v_group_id, priority
    FROM upstream_accounts
    WHERE org_id = v_org_id AND platform = 'anthropic' AND deleted_at IS NULL;

    UPDATE api_keys SET group_id = v_group_id
    WHERE org_id = v_org_id AND group_id IS NULL AND deleted_at IS NULL;
  END LOOP;
END $$;
```

`0008_down.sql`:

```sql
ALTER TABLE upstream_accounts
  DROP CONSTRAINT IF EXISTS subscription_tier_values,
  DROP COLUMN IF EXISTS subscription_tier;

DROP INDEX IF EXISTS api_keys_group_idx;
ALTER TABLE api_keys DROP COLUMN IF EXISTS group_id;

DROP TABLE IF EXISTS account_group_members;
DROP TABLE IF EXISTS account_groups;
```

### 4.2 Migration 0009 — `model_pricing` + seed

```sql
-- Up

CREATE TABLE model_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_per_million_micros BIGINT NOT NULL,
  output_per_million_micros BIGINT NOT NULL,
  cached_5m_per_million_micros BIGINT,   -- Anthropic prompt cache 5min TTL
  cached_1h_per_million_micros BIGINT,   -- Anthropic prompt cache 1hr TTL
  cached_input_per_million_micros BIGINT, -- OpenAI cached input rate
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT model_pricing_platform_values
    CHECK (platform IN ('anthropic', 'openai', 'gemini', 'antigravity')),
  CONSTRAINT model_pricing_effective_range
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX model_pricing_active_idx
  ON model_pricing (platform, model_id, effective_from);

CREATE INDEX model_pricing_lookup_idx
  ON model_pricing (platform, model_id, effective_from DESC);

-- Seed (snapshot 2026-04-28; PR review must verify against provider pricing pages)
INSERT INTO model_pricing (platform, model_id,
  input_per_million_micros, output_per_million_micros,
  cached_5m_per_million_micros, cached_1h_per_million_micros, cached_input_per_million_micros,
  effective_from)
VALUES
  -- Anthropic (5m / 1h cache pricing per Anthropic prompt-cache docs)
  ('anthropic', 'claude-opus-4-7',     15000000, 75000000, 18750000, 30000000, NULL, '2026-04-28'),
  ('anthropic', 'claude-sonnet-4-6',    3000000, 15000000,  3750000,  6000000, NULL, '2026-04-28'),
  ('anthropic', 'claude-haiku-4-5',     1000000,  5000000,  1250000,  2000000, NULL, '2026-04-28'),
  -- OpenAI (cached_input only; no 5m/1h split)
  ('openai',    'gpt-4o',               2500000, 10000000, NULL, NULL, 1250000, '2026-04-28'),
  ('openai',    'gpt-4o-mini',           150000,   600000, NULL, NULL,   75000, '2026-04-28'),
  ('openai',    'o1',                  15000000, 60000000, NULL, NULL, 7500000, '2026-04-28'),
  ('openai',    'o1-mini',              3000000, 12000000, NULL, NULL, 1500000, '2026-04-28');
```

`0009_down.sql`:
```sql
DROP TABLE IF EXISTS model_pricing;
```

### 4.3 Migration 0010 — `usage_logs` extension (additive)

ai-dev-eval's `llm_usage_events` (4C Phase 1) is additive-extended. Adopting sub2api's name `usage_logs` would break too much; we keep `llm_usage_events` and add columns:

```sql
-- Up

ALTER TABLE llm_usage_events
  ADD COLUMN cache_creation_5m_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cache_creation_cost DECIMAL(20, 10) NOT NULL DEFAULT 0,
  ADD COLUMN cache_read_cost DECIMAL(20, 10) NOT NULL DEFAULT 0,
  ADD COLUMN actual_cost_usd DECIMAL(10, 6) NOT NULL DEFAULT 0,
  ADD COLUMN platform TEXT,
  ADD COLUMN account_id UUID REFERENCES upstream_accounts(id) ON DELETE SET NULL,
  ADD COLUMN group_id UUID REFERENCES account_groups(id) ON DELETE SET NULL,
  ADD COLUMN duration_ms INTEGER,
  ADD COLUMN stream BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX llm_usage_events_account_idx ON llm_usage_events (account_id, created_at);
CREATE INDEX llm_usage_events_group_idx ON llm_usage_events (group_id, created_at);
CREATE INDEX llm_usage_events_platform_idx ON llm_usage_events (platform, created_at);

-- Backfill platform from account if account_id set; otherwise leave NULL (4C-era rows)
-- Backfill is run as separate idempotent job, not in migration (avoids long lock)
```

`0010_down.sql`:
```sql
DROP INDEX IF EXISTS llm_usage_events_platform_idx;
DROP INDEX IF EXISTS llm_usage_events_group_idx;
DROP INDEX IF EXISTS llm_usage_events_account_idx;

ALTER TABLE llm_usage_events
  DROP COLUMN IF EXISTS stream,
  DROP COLUMN IF EXISTS duration_ms,
  DROP COLUMN IF EXISTS group_id,
  DROP COLUMN IF EXISTS account_id,
  DROP COLUMN IF EXISTS platform,
  DROP COLUMN IF EXISTS actual_cost_usd,
  DROP COLUMN IF EXISTS cache_read_cost,
  DROP COLUMN IF EXISTS cache_creation_cost,
  DROP COLUMN IF EXISTS cached_input_tokens,
  DROP COLUMN IF EXISTS cache_read_tokens,
  DROP COLUMN IF EXISTS cache_creation_1h_tokens,
  DROP COLUMN IF EXISTS cache_creation_5m_tokens;
```

### 4.4 Drizzle schema updates

```ts
// packages/db/src/schema/accountGroups.ts (NEW)
export const accountGroups = pgTable('account_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  platform: text('platform').notNull(),
  rateMultiplier: decimal('rate_multiplier', { precision: 10, scale: 4 }).notNull().default('1.0'),
  isExclusive: boolean('is_exclusive').notNull().default(false),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const accountGroupMembers = pgTable('account_group_members', {
  accountId: uuid('account_id').notNull().references(() => upstreamAccounts.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull().references(() => accountGroups.id, { onDelete: 'cascade' }),
  priority: integer('priority').notNull().default(50),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.accountId, t.groupId] }),
}));

// packages/db/src/schema/apiKeys.ts (existing, modify)
export const apiKeys = pgTable('api_keys', {
  // ... existing columns
  groupId: uuid('group_id').references(() => accountGroups.id, { onDelete: 'set null' }),
});

// packages/db/src/schema/accounts.ts (existing, modify)
export const upstreamAccounts = pgTable('upstream_accounts', {
  // ... existing columns
  subscriptionTier: text('subscription_tier'),
});

// packages/db/src/schema/modelPricing.ts (NEW)
export const modelPricing = pgTable('model_pricing', {
  id: uuid('id').primaryKey().defaultRandom(),
  platform: text('platform').notNull(),
  modelId: text('model_id').notNull(),
  inputPerMillionMicros: bigint('input_per_million_micros', { mode: 'bigint' }).notNull(),
  outputPerMillionMicros: bigint('output_per_million_micros', { mode: 'bigint' }).notNull(),
  cached5mPerMillionMicros: bigint('cached_5m_per_million_micros', { mode: 'bigint' }),
  cached1hPerMillionMicros: bigint('cached_1h_per_million_micros', { mode: 'bigint' }),
  cachedInputPerMillionMicros: bigint('cached_input_per_million_micros', { mode: 'bigint' }),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  effectiveTo: timestamp('effective_to', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// packages/db/src/schema/llmUsageEvents.ts (existing, modify)
// ... add new columns per migration 0010
```

---

## 5. Group concept (architectural shift)

### 5.1 Conceptual model

```
            ┌─────────────────────────────────────────┐
            │ Organization (existing)                  │
            └────────┬────────────────────────────────┘
                     │
       ┌─────────────┼─────────────────┐
       │             │                 │
       ▼             ▼                 ▼
┌────────────┐ ┌────────────┐  ┌────────────────┐
│ User (4A)  │ │ Team (4A)  │  │ AccountGroup   │  (NEW 5A)
└─────┬──────┘ └────────────┘  │ - platform     │
      │                        │ - rate_mult    │
      ▼                        └───────┬────────┘
┌────────────┐                         │
│ ApiKey     │ ─── group_id ──────────►│
│ (4A)       │                         │
└────────────┘                         │
                                       │
              ┌────────────────────────┘
              │ many-to-many via account_group_members
              ▼
       ┌────────────────────┐
       │ UpstreamAccount    │  (existing 4A; same row can be in multiple groups)
       │ - platform         │
       │ - type (oauth|key) │
       │ - subscription_tier│  (NEW 5A)
       └────────────────────┘
```

### 5.2 Group invariants

1. **One group, one platform** — `account_groups.platform` is set at creation, immutable
2. **Account-group join requires platform match** — server rejects adding `account.platform != group.platform`
3. **One API key, one group (or NULL)** — `api_keys.group_id` is nullable; NULL means "legacy 4A behaviour" (use any anthropic account in org)
4. **Migration auto-creates `legacy-anthropic` group + assigns existing keys/accounts** — see migration 0008 backfill

### 5.3 Routing dispatch

```ts
// apps/gateway/src/runtime/groupDispatch.ts (NEW)

export interface GroupContext {
  groupId: string;
  platform: 'anthropic' | 'openai' | 'gemini' | 'antigravity';
  rateMultiplier: number;
  isExclusive: boolean;
}

export async function resolveGroupContext(
  db: Db,
  apiKey: ApiKey,
): Promise<GroupContext | null> {
  if (!apiKey.groupId) {
    // Legacy 4A behaviour — synthesise a virtual group of all anthropic accounts in org
    return {
      groupId: 'legacy:' + apiKey.orgId,
      platform: 'anthropic',
      rateMultiplier: 1.0,
      isExclusive: false,
    };
  }
  const row = await db.query.accountGroups.findFirst({
    where: and(
      eq(accountGroups.id, apiKey.groupId),
      isNull(accountGroups.deletedAt),
      eq(accountGroups.status, 'active'),
    ),
  });
  if (!row) return null;
  return {
    groupId: row.id,
    platform: row.platform as any,
    rateMultiplier: Number(row.rateMultiplier),
    isExclusive: row.isExclusive,
  };
}
```

Route handlers consult `GroupContext.platform` and dispatch (see §9).

### 5.4 Account membership rules

- An account can belong to multiple groups (e.g., one OpenAI sk-key in both `openai-prod` and `openai-experimental`)
- Adding an account to a group requires `account.platform === group.platform`
- Removing an account from a group does NOT delete the account; soft-removes the join row
- Group's `is_exclusive=true` means this account cannot be added to any other group (matches sub2api behaviour for tightly-controlled subscriptions)

### 5.5 RBAC additions

| Action | Role | Scope |
|---|---|---|
| `account_group.list` | member+ | own org |
| `account_group.create` | admin | own org |
| `account_group.update` | admin | own org |
| `account_group.delete` | admin | own org |
| `account_group.add_account` | admin | own org |
| `account_group.remove_account` | admin | own org |

---

## 6. OAuth flow (OpenAI Codex device-code, vendored client_id)

### 6.1 Vendored constants

`apps/gateway/src/oauth/openaiCodexConstants.ts` (NEW):

```ts
/**
 * Vendored from sub2api repo (Wei-Shaw/sub2api),
 * which itself vendored from Codex CLI (@openai/codex npm package).
 * Source path: /tmp/aide-research/sub2api/backend/internal/pkg/openai/oauth.go:19-26
 * Vendored on: 2026-04-28
 * Re-vendor process: docs/runbooks/openai-oauth-vendor-update.md
 */
export const OPENAI_CODEX_OAUTH = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  defaultRedirectURI: 'http://localhost:1455/auth/callback',
  scopes: ['openid', 'email', 'profile', 'offline_access'],
  refreshScopes: 'openid email profile offline_access',  // space-separated for refresh request
  pkceMethod: 'S256' as const,
  // approximate observed lifetimes (sub2api comment)
  approxAccessLifetimeSec: 60 * 60,
  approxRefreshLifetimeSec: 30 * 24 * 60 * 60,
} as const;

export const OPENAI_API_BASE = 'https://api.openai.com';
export const CHATGPT_BACKEND_API = 'https://chatgpt.com/backend-api';
```

### 6.2 Flow (admin creating OAuth account)

Loopback-redirect OAuth + PKCE:

```
Admin UI                 Gateway API (tRPC)        OpenAI auth.openai.com
   │                          │                        │
   │ initiateOAuth({platform: │                        │
   │   'openai',              │                        │
   │   subscriptionTier: 'pro'})│                      │
   ├─────────────────────────►│                        │
   │                          │ generate state + PKCE  │
   │                          │ save Redis             │
   │                          │   key=oauth:flow:<id>  │
   │                          │   ttl=15min            │
   │                          │ build authorize URL    │
   │ {flowId, authorizeUrl,   │                        │
   │  state}                  │                        │
   │◄─────────────────────────┤                        │
   │                          │                        │
   │ window.open(authorizeUrl)│                        │
   │ admin completes login    │                        │
   │ browser redirects to     │                        │
   │ http://localhost:1455/   │                        │
   │   auth/callback?code=... │                        │
   │   &state=...             │                        │
   │                          │                        │
   │ POST /admin/oauth/callback                        │
   │ {flowId, code, state}    │                        │
   ├─────────────────────────►│                        │
   │                          │ verify state           │
   │                          │ POST /oauth/token      │
   │                          ├───────────────────────►│
   │                          │ {access_token,         │
   │                          │  refresh_token,        │
   │                          │  expires_in: 3600}     │
   │                          │◄───────────────────────┤
   │                          │ encrypt + store in     │
   │                          │   credential_vault     │
   │                          │ create upstream_account│
   │                          │ probe via no-op call   │
   │                          │   (max_output_tokens=1)│
   │                          │ if ImpersonateChrome OK│
   │                          │   fetch plan_type from │
   │                          │   chatgpt.com/backend- │
   │                          │   api/me               │
   │                          │   set subscription_tier│
   │ {accountId, status, tier}│                        │
   │◄─────────────────────────┤                        │
```

### 6.3 Loopback callback handler

The browser redirects to `http://localhost:1455/auth/callback?code=...&state=...`. ai-dev-eval gateway needs to either:

**Option A — gateway listens on 1455 itself**: gateway runs an extra HTTP listener on port 1455 specifically for OAuth callback; receives code, looks up flow_id by state, completes the flow.

**Option B — bundled local helper**: admin runs a small CLI helper (`pnpm aide-oauth-callback`) that listens on 1455 and POSTs the code to gateway's API; admin pastes the URL printed by helper.

**Decision A21**: **Option A** — gateway adds a single route `GET /admin/oauth/callback` on port 1455 (not the main Fastify port). Implemented as a separate Fastify instance bound to localhost:1455 only when `ENABLE_OPENAI_PROVIDER=true`. Less friction for admin; single binary.

**Risk**: port collision (admin already running another OAuth flow on 1455). Detection: if port unavailable at gateway start, log warning + skip OAuth listener; admin can use Option B as fallback.

### 6.4 PKCE helpers

`apps/gateway/src/oauth/pkce.ts` (NEW):

```ts
import { createHash, randomBytes } from 'node:crypto';

export function generatePKCEVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return sha256Base64Url(verifier);
}
```

### 6.5 Refresh-token rotation

Per A4 + sub2api `pkg/openai/oauth.go` `BuildRefreshTokenRequest`:

```ts
async function refresh(refreshToken: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: OPENAI_CODEX_OAUTH.clientId,
    refresh_token: refreshToken,
    scope: OPENAI_CODEX_OAUTH.refreshScopes,
  });
  const res = await fetch(OPENAI_CODEX_OAUTH.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && text.includes('invalid_grant')) {
      throw new OAuthRefreshTokenInvalid(text);
    }
    throw new OAuthRefreshFailed(`http_${res.status}: ${text}`);
  }
  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,  // rotation per A4
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}
```

`replaceTokens` in vault is a single atomic SQL UPDATE so concurrent refreshes converge.

---

## 7. Per-platform 4-piece OAuth pattern

Per cross-cutting decision X3 + sub2api `wire.go:55-130`. 5A introduces this for OpenAI; Anthropic stays on existing monolithic `oauthRefresh.ts` until 5D (decision A11).

### 7.1 Interfaces

`apps/gateway/src/oauth/types.ts` (NEW):

```ts
import type { Platform } from '@aide/db/schema';

// 1. OAuthService — interactive flow (admin-side, account creation/re-auth)
export interface OAuthService {
  platform: Platform;
  generateAuthURL(opts: { redirectURI?: string }): Promise<{ authUrl: string; state: string; codeVerifier: string }>;
  exchangeCode(opts: { code: string; codeVerifier: string; redirectURI?: string }): Promise<TokenSet>;
}

// 2. TokenProvider — hot-path fetch (caller is request handler)
export interface TokenProvider {
  platform: Platform;
  getAccessToken(accountId: string): Promise<{ accessToken: string }>;
  invalidate(accountId: string): void;
}

// 3. TokenRefresher — executor (called by both background scheduler + on-demand)
export interface TokenRefresher {
  platform: Platform;
  refresh(refreshToken: string): Promise<TokenSet>;
}

// 4. RefreshPolicy — per-platform tunables
export type RefreshErrorAction = 'use_existing_token' | 'return_error';
export type LockHeldAction = 'wait_for_cache' | 'use_existing_token';

export interface RefreshPolicy {
  platform: Platform;
  onRefreshError: RefreshErrorAction;
  onLockHeld: LockHeldAction;
  failureTTLMs: number;  // 0 means no TTL (each call retries immediately)
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tokenType?: string;
}
```

### 7.2 Per-platform RefreshPolicy values (X4)

`apps/gateway/src/oauth/policies.ts` (NEW):

```ts
export const ANTHROPIC_REFRESH_POLICY: RefreshPolicy = {
  platform: 'anthropic',
  onRefreshError: 'use_existing_token',
  onLockHeld: 'wait_for_cache',
  failureTTLMs: 60_000,  // 1 min
};

export const OPENAI_REFRESH_POLICY: RefreshPolicy = {
  platform: 'openai',
  onRefreshError: 'use_existing_token',
  onLockHeld: 'wait_for_cache',
  failureTTLMs: 60_000,
};

export const GEMINI_REFRESH_POLICY: RefreshPolicy = {
  platform: 'gemini',
  onRefreshError: 'return_error',
  onLockHeld: 'use_existing_token',
  failureTTLMs: 0,
};

export const ANTIGRAVITY_REFRESH_POLICY: RefreshPolicy = {
  platform: 'antigravity',
  onRefreshError: 'return_error',
  onLockHeld: 'use_existing_token',
  failureTTLMs: 0,
};
```

### 7.3 Unified `OAuthRefreshAPI` (X3 + sub2api `wire.go:42-46`)

`apps/gateway/src/oauth/refreshApi.ts` (NEW) — orchestrates background scheduler + on-demand refresh through a single Redis-backed lock:

```ts
export class OAuthRefreshAPI {
  constructor(
    private deps: {
      db: Db;
      vault: CredentialVault;
      redis: Redis;
      providers: Record<Platform, OAuthService>;
      refreshers: Record<Platform, TokenRefresher>;
      policies: Record<Platform, RefreshPolicy>;
    },
  ) {}

  /**
   * Returns a valid access token for the account. Uses cache; refreshes if expiring.
   * Acquires Redis lock to prevent concurrent refresh races.
   */
  async getValidAccessToken(accountId: string): Promise<{ accessToken: string }> {
    const cached = await this.deps.vault.peekAccessToken(accountId);
    if (cached && cached.expiresAt.getTime() > Date.now() + 5 * 60 * 1000) {
      return { accessToken: cached.token };
    }

    const account = await this.loadAccount(accountId);
    const policy = this.deps.policies[account.platform];

    const lockKey = `oauth:refresh-lock:${accountId}`;
    const lockAcquired = await this.deps.redis.set(lockKey, '1', 'EX', 30, 'NX');

    if (!lockAcquired) {
      // Another refresh is in progress
      if (policy.onLockHeld === 'wait_for_cache') {
        await this.waitForCacheRefresh(accountId, 5_000);
        const after = await this.deps.vault.peekAccessToken(accountId);
        if (after) return { accessToken: after.token };
      }
      // policy = 'use_existing_token'
      if (cached) return { accessToken: cached.token };
      throw new Error('no_token_available');
    }

    try {
      const refreshToken = await this.deps.vault.readRefreshToken(accountId);
      const refresher = this.deps.refreshers[account.platform];
      const tokens = await refresher.refresh(refreshToken);
      await this.deps.vault.replaceTokens(accountId, tokens);
      return { accessToken: tokens.accessToken };
    } catch (err) {
      if (err instanceof OAuthRefreshTokenInvalid) {
        await this.markAccountOAuthInvalid(accountId, String(err));
        throw err;
      }
      // policy = 'use_existing_token' OR 'return_error'
      if (policy.onRefreshError === 'use_existing_token' && cached) {
        await this.recordTransientFailure(accountId, policy.failureTTLMs);
        return { accessToken: cached.token };
      }
      throw err;
    } finally {
      await this.deps.redis.del(lockKey);
    }
  }
}
```

### 7.4 OpenAI implementations

`apps/gateway/src/oauth/openai/openaiOAuthService.ts` (NEW) — interactive flow per §6
`apps/gateway/src/oauth/openai/openaiTokenRefresher.ts` (NEW) — `refresh()` per §6.5
`apps/gateway/src/oauth/openai/openaiTokenProvider.ts` (NEW) — wraps `OAuthRefreshAPI.getValidAccessToken` for OpenAI

All four pieces composed in DI per `wire.go` pattern.

### 7.5 Background refresh scheduler

`apps/gateway/src/oauth/backgroundScheduler.ts` (NEW) — runs every 1 min, scans for accounts with `expires_at - 5min < NOW`, calls `OAuthRefreshAPI.getValidAccessToken` (which becomes a refresh); honours per-platform `BackgroundRefreshPolicy` for skip-counting.

---

## 8. Account scheduler (3-layer)

Per cross-cutting decision X6 + sub2api `openai_account_scheduler.go:242-310`. Replaces 4A's single-layer `failoverLoop.ts`.

### 8.1 Interface

`apps/gateway/src/runtime/scheduler.ts` (NEW):

```ts
export interface ScheduleRequest {
  groupId: string;
  groupPlatform: Platform;
  sessionHash?: string;
  previousResponseId?: string;
  stickyAccountId?: string;
  requestedModel: string;
  excludedAccountIds?: Set<string>;
}

export type ScheduleLayer = 'previous_response_id' | 'session_hash' | 'load_balance';

export interface ScheduleDecision {
  layer: ScheduleLayer;
  stickyHit: boolean;
  candidateCount: number;
  selectedAccountId: string;
  selectedAccountType: 'oauth' | 'apikey';
  loadSkew: number;
  latencyMs: number;
}

export interface AccountScheduler {
  select(req: ScheduleRequest): Promise<{ account: Account; decision: ScheduleDecision; release: () => Promise<void> }>;
  reportResult(accountId: string, success: boolean, firstTokenMs?: number): void;
  reportSwitch(): void;
  snapshotMetrics(): SchedulerMetrics;
}
```

### 8.2 Three layers

```
                    Select(req)
                        │
            ┌───────────┴────────────┐
            │ Layer 1: previous_response_id
            │ if req.previousResponseId set
            │   look up Redis key sticky:resp:<id> → accountId
            │   if hit + account valid + in group + not excluded → return
            │   else fall through
            ▼
            ┌────────────────────────┐
            │ Layer 2: session_hash
            │ if req.sessionHash set
            │   look up Redis key sticky:session:<group>:<hash> → accountId
            │   if hit + valid → return; refresh TTL
            │   else fall through
            ▼
            ┌────────────────────────┐
            │ Layer 3: load_balance
            │ list all schedulable accounts in group (not excluded)
            │ score each: weighted_score = base_priority * (1 - errorRateEWMA) * 1/ttftEWMA
            │ pick top-K (default 3); weighted random among them
            │ acquire concurrency slot (Redis ZSET); if all full → WaitPlan
            │ bind sessionHash → accountId in Redis
            └────────────────────────┘
```

### 8.3 EWMA tracking (per-account runtime stats)

```ts
class AccountRuntimeStats {
  private accounts = new Map<string, AccountStat>();

  record(accountId: string, success: boolean, firstTokenMs?: number) {
    const stat = this.accounts.get(accountId) ?? { errorRate: 0, ttft: NaN, lastUpdate: 0 };
    const alpha = 0.2;  // EWMA smoothing factor
    stat.errorRate = alpha * (success ? 0 : 1) + (1 - alpha) * stat.errorRate;
    if (firstTokenMs !== undefined) {
      stat.ttft = isNaN(stat.ttft) ? firstTokenMs : alpha * firstTokenMs + (1 - alpha) * stat.ttft;
    }
    stat.lastUpdate = Date.now();
    this.accounts.set(accountId, stat);
  }

  score(accountId: string): { errorRate: number; ttft: number } {
    return this.accounts.get(accountId) ?? { errorRate: 0, ttft: NaN };
  }
}
```

### 8.4 Concurrency slot (Redis ZSET)

Same pattern as 4A's `acquireSlot` / `releaseSlot` (`apps/gateway/src/redis/slots.ts`). Reused as-is.

### 8.5 SessionHash generation

Per sub2api `gateway_request.go GenerateSessionHash`:

1. **Highest priority**: parse `metadata.user_id` matching pattern `user_<hash>_account__session_<uuid>` (Claude Code injects this); use the UUID
2. **Mid**: hash of (`system` + `messages`) — content-based for non-Claude-Code clients
3. **Lowest fallback**: hash of `messages` only

### 8.6 Failover (replaces 4A `failoverLoop`)

The old `runFailover` becomes a thin wrapper over `scheduler.select()`:

```ts
export async function runFailover<T>(
  req: ScheduleRequest,
  attempt: (account: Account) => Promise<T>,
  opts: { maxSwitches: number },
): Promise<T> {
  const excluded = new Set<string>();
  for (let i = 0; i <= opts.maxSwitches; i++) {
    const { account, decision, release } = await scheduler.select({ ...req, excludedAccountIds: excluded });
    try {
      const result = await attempt(account);
      scheduler.reportResult(account.id, true /* success */);
      return result;
    } catch (err) {
      scheduler.reportResult(account.id, false);
      const action = classifyUpstreamError(err);
      if (action === 'fatal') throw err;
      if (action === 'retryable_other_account') {
        excluded.add(account.id);
        scheduler.reportSwitch();
        continue;
      }
      throw err;
    } finally {
      await release();
    }
  }
  throw new AllUpstreamsFailed([...excluded]);
}
```

### 8.7 Metrics

| Metric | Type | Notes |
|---|---|---|
| `gw_scheduler_select_total{platform,layer}` | counter | sticky vs load_balance breakdown |
| `gw_scheduler_sticky_hit_ratio{platform}` | gauge | EWMA |
| `gw_scheduler_account_switch_total{platform}` | counter | failover events |
| `gw_scheduler_latency_ms{platform}` | histogram | scheduler decision time |
| `gw_scheduler_load_skew{platform}` | gauge | distribution evenness |
| `gw_scheduler_runtime_account_count{platform}` | gauge | tracked accounts |

---

## 9. Routes

Per cross-cutting decision X9 + sub2api `routes/gateway.go:44-115`. Three URL spaces, auto-route by group platform.

### 9.1 Route table

| Path | Format | Auto-route based on `group.platform` |
|---|---|---|
| `POST /v1/messages` | Anthropic | `anthropic` → AnthropicHandler; `openai` → OpenAIHandler.Messages (translates body to Responses); `gemini` → (Plan 5B) |
| `POST /v1/messages/count_tokens` | Anthropic | `openai` → 404 (sub2api pattern); `anthropic` → existing |
| `POST /v1/chat/completions` | OpenAI Chat | `openai` → OpenAIHandler.ChatCompletions; `anthropic` → AnthropicHandler.ChatCompletions (existing 4A translate path) |
| `POST /v1/responses` | OpenAI Responses | `openai` → OpenAIHandler.Responses; `anthropic` → AnthropicHandler.Responses (translate Responses → Messages) |
| `POST /v1/responses/*subpath` | OpenAI Responses | same as above (Codex CLI uses subpaths) |
| `POST /backend-api/codex/responses` | OpenAI Responses | Codex CLI's native URL; **always** routes to OpenAI handler regardless of group platform (force) |
| `GET /v1/models` | meta | platform-dependent model list |

### 9.2 Handler dispatch helper

```ts
// apps/gateway/src/routes/dispatch.ts (NEW)
export function autoRoute(
  byPlatform: Partial<Record<Platform, FastifyHandler>>,
  fallback?: FastifyHandler,
): FastifyHandler {
  return async (req, reply) => {
    const groupCtx = req.gwGroupContext as GroupContext | undefined;
    const platform = groupCtx?.platform ?? 'anthropic';  // legacy default
    const handler = byPlatform[platform] ?? fallback;
    if (!handler) {
      reply.code(404).send({ error: 'platform_not_supported_by_route' });
      return;
    }
    await handler(req, reply);
  };
}
```

Registration:

```ts
// apps/gateway/src/server.ts (modify)
app.post('/v1/messages', autoRoute({
  anthropic: anthropicHandlers.messages,
  openai: openaiHandlers.messages,  // NEW 5A — body translates Anthropic → OpenAI Responses
}));

app.post('/v1/chat/completions', autoRoute({
  anthropic: anthropicHandlers.chatCompletions,  // existing 4A translate path
  openai: openaiHandlers.chatCompletions,         // NEW 5A — passthrough or transformed to Responses
}));

app.post('/v1/responses', autoRoute({
  anthropic: anthropicHandlers.responses,  // NEW 5A — translate Responses → Messages
  openai: openaiHandlers.responses,         // NEW 5A — passthrough
}));

// Codex CLI compatibility — always OpenAI handler
app.post('/backend-api/codex/responses', openaiHandlers.responses);
app.post('/backend-api/codex/responses/*subpath', openaiHandlers.responses);
```

### 9.3 Middleware extensions

`apps/gateway/src/middleware/groupContext.ts` (NEW) — runs after `apiKeyAuthPlugin`, attaches `req.gwGroupContext` from `resolveGroupContext` (§5.3). If group's status is disabled or platform is gemini/antigravity (5A doesn't support yet), returns 403.

### 9.4 `/v1/responses` Zod schema

Per decision A6:

```ts
const responsesRequestSchema = z.object({
  model: z.string(),
  input: z.union([
    z.string(),
    z.array(z.object({
      role: z.enum(['user', 'assistant', 'system', 'developer']),
      content: z.union([z.string(), z.array(z.unknown())]),
    })),
  ]),
  instructions: z.string().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.object({
    type: z.literal('function'),
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()),
  })).optional(),
  tool_choice: z.union([
    z.literal('auto'),
    z.literal('none'),
    z.object({ type: z.literal('function'), name: z.string() }),
  ]).optional(),
});

function rejectUnsupportedFeatures(body: any) {
  const unsupported = ['previous_response_id', 'store', 'parallel_tool_calls', 'file_search', 'code_interpreter', 'computer_use'];
  for (const key of unsupported) {
    if (body[key] !== undefined) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `unsupported_feature: ${key}` });
    }
  }
}
```

---

## 10. Body + stream translators

Per decision A17, translators live in `packages/gateway-core/src/translate/`. 4A already has `chat ↔ messages`; 5A adds `messages ↔ responses` and stream variants.

### 10.1 Translator inventory after 5A

```
packages/gateway-core/src/translate/
├── chatToAnthropic.ts                 (4A existing)
├── anthropicToChat.ts                 (4A existing)
├── responsesToAnthropic.ts            (NEW 5A)
├── anthropicToResponses.ts            (NEW 5A)
├── chatToResponses.ts                 (NEW 5A — composes via anthropic pivot)
├── responsesToChat.ts                 (NEW 5A — composes via anthropic pivot)
├── stopReasonMap.ts                   (NEW 5A)
├── dispatch.ts                        (NEW 5A — direction lookup table)
└── stream/
    ├── anthropicStreamToChatStream.ts        (NEW 5A — completes 4A's Part 6.7 TODO)
    ├── chatStreamToAnthropicStream.ts        (NEW 5A)
    ├── anthropicStreamToResponsesStream.ts   (NEW 5A)
    ├── responsesStreamToAnthropicStream.ts   (NEW 5A)
    ├── chatStreamToResponsesStream.ts        (NEW 5A — pivot)
    ├── responsesStreamToChatStream.ts        (NEW 5A — pivot)
    └── pipe.ts                                (NEW 5A — Transform stream wrapper)
```

### 10.2 Why 5A needs all 6 directions

User's clients in scope:
- Claude Code → `/v1/messages` (Anthropic format)
- Codex CLI → `/v1/responses` and `/backend-api/codex/responses` (Responses format)
- generic OpenAI SDK → `/v1/chat/completions` (Chat format)

Group platforms:
- `anthropic` group: serves Anthropic upstream
- `openai` group: serves OpenAI upstream (Chat or Responses depending on account capability)

So the 9-cell matrix has 3 passthrough + 6 cross-format. All 6 cross-format need translators. (Same as my earlier 5A design — that one direction count is correct.)

### 10.3 Mapping highlights (full mapping tables in 5A impl plan)

**Anthropic Messages ↔ OpenAI Responses** key differences:
- `system` ↔ `instructions`
- `messages: [{role, content}]` ↔ `input: [{role, content}]` (similar shape)
- `max_tokens` ↔ `max_output_tokens`
- Anthropic `tool_use` content block ↔ Responses `function_call` output item
- Anthropic `tool_result` content block ↔ Responses `function_call_output` input item
- Stop reason: see 10.4

**Stream event taxonomy**:
- Anthropic: `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`
- OpenAI Chat: `data: {choices: [{delta: ...}]}` chunks ending `data: [DONE]`
- OpenAI Responses: `event: response.created`, `event: response.output_text.delta`, `event: response.completed`

### 10.4 Stop-reason map

| Anthropic | OpenAI Chat | OpenAI Responses |
|---|---|---|
| `end_turn` | `stop` | `stop` |
| `max_tokens` | `length` | `max_output_tokens` |
| `tool_use` | `tool_calls` | `tool_calls` |
| `stop_sequence` | `stop` | `stop` |
| `refusal` | `content_filter` | `content_filter` |

### 10.5 Stream translator pattern

Per sub2api `pkg/openai/openai_*_transform.go` style — pure stateful function:

```ts
export interface StreamTranslator<U, C> {
  onEvent(event: U): C[];
  onEnd(): C[];
  onError(err: { kind: string; message: string }): C[];
}
```

`pipeStreamTranslator(upstream, factory)` consumes `ReadableStream<Uint8Array>` of upstream SSE bytes, parses event-by-event, applies translator, serializes to client SSE bytes.

State held per translator: ~5 fields (open block type, accumulated text buffer, final stop reason, final usage, message envelope flag).

### 10.6 Pivot composition (cross-OpenAI-format)

Per decision A2 in main design + sub2api convention: `chat ↔ responses` translation pivots through Anthropic Messages, since 4A already has `chat ↔ messages` translators. Saves 4 translator implementations.

```ts
// chatToResponses.ts
export function translateChatToResponses(body: ChatRequest): ResponsesRequest {
  return translateAnthropicToResponses(translateChatToAnthropic(body));
}
```

Latency cost ~1ms per request (parse/serialize); negligible. For stream:

```ts
// stream/chatStreamToResponsesStream.ts
export function makeChatStreamToResponsesStream(): StreamTranslator<ChatEvent, ResponsesEvent> {
  const ca = makeChatStreamToAnthropicStream();
  const ar = makeAnthropicStreamToResponsesStream();
  return {
    onEvent(e) { return ca.onEvent(e).flatMap(x => ar.onEvent(x)); },
    onEnd() { const tail = ca.onEnd().flatMap(x => ar.onEvent(x)); return [...tail, ...ar.onEnd()]; },
    onError(err) { return ar.onError(err); },
  };
}
```

### 10.7 Dispatch table

```ts
// packages/gateway-core/src/translate/dispatch.ts
export type Format = 'anthropic' | 'openai-chat' | 'openai-responses';

type Direction = `${Format}->${Format}`;

export const requestTranslators: Record<Direction, ((body: any) => any) | 'passthrough'> = {
  'anthropic->anthropic':         'passthrough',
  'anthropic->openai-chat':        translateAnthropicToChat,
  'anthropic->openai-responses':   translateAnthropicToResponses,
  'openai-chat->anthropic':        translateChatToAnthropic,
  'openai-chat->openai-chat':      'passthrough',
  'openai-chat->openai-responses': translateChatToResponses,
  'openai-responses->anthropic':   translateResponsesToAnthropic,
  'openai-responses->openai-chat': translateResponsesToChat,
  'openai-responses->openai-responses': 'passthrough',
};

// Equivalent for responseTranslators + streamTranslators
```

### 10.8 Test approach

- **Body translator unit tests**: 10+ cases per direction (text, tool use, multi-turn, image, edge cases)
- **Stream translator snapshot tests**: SSE fixtures recorded from real upstream once, replayed event-by-event
- **Property tests** (fast-check): random valid event sequences, assert translator never throws + always produces parseable output
- **Tool-use round-trip tests**: each direction × tool-use scenario; verify semantic preservation

---

## 11. Cost mapping

### 11.1 Pricing lookup (DB-backed, replaces 4C constants)

`packages/evaluator/src/cost/pricing.ts` (refactor):

```ts
export interface ModelPricingRow {
  inputPerMillionMicros: bigint;
  outputPerMillionMicros: bigint;
  cached5mPerMillionMicros: bigint | null;     // Anthropic only
  cached1hPerMillionMicros: bigint | null;     // Anthropic only
  cachedInputPerMillionMicros: bigint | null;  // OpenAI only
}

export interface PricingLookup {
  lookup(platform: Platform, model: string, at: Date): Promise<ModelPricingRow | null>;
  invalidate(platform: Platform, model: string): void;
}

export function createPricingLookup(db: Db, opts?: { cacheTtlMs?: number }): PricingLookup;
```

In-process LRU cache, 5-min TTL keyed by `(platform, model)`. Cache miss queries `model_pricing` (filter `effective_from <= at < effective_to`).

### 11.2 Cost compute

```ts
// packages/evaluator/src/cost/computeCost.ts
export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheCreation5mTokens?: number;  // Anthropic
  cacheCreation1hTokens?: number;  // Anthropic
  cacheReadTokens?: number;         // Anthropic (uncached input)
  cachedInputTokens?: number;        // OpenAI
}

export function computeCost(
  pricing: ModelPricingRow,
  usage: UsageBreakdown,
): { totalCost: number; breakdown: { input: number; output: number; cacheCreation: number; cacheRead: number; cachedInput: number } } {
  const microsPerMillion = 1_000_000n;
  // Anthropic path
  const cache5mMicros = usage.cacheCreation5mTokens && pricing.cached5mPerMillionMicros
    ? BigInt(usage.cacheCreation5mTokens) * pricing.cached5mPerMillionMicros / microsPerMillion : 0n;
  const cache1hMicros = usage.cacheCreation1hTokens && pricing.cached1hPerMillionMicros
    ? BigInt(usage.cacheCreation1hTokens) * pricing.cached1hPerMillionMicros / microsPerMillion : 0n;
  const cacheReadMicros = usage.cacheReadTokens
    ? BigInt(usage.cacheReadTokens) * pricing.inputPerMillionMicros / microsPerMillion : 0n;  // read at input rate
  // OpenAI path
  const cachedInputMicros = usage.cachedInputTokens && pricing.cachedInputPerMillionMicros
    ? BigInt(usage.cachedInputTokens) * pricing.cachedInputPerMillionMicros / microsPerMillion : 0n;
  // Common
  const billableInputTokens = usage.inputTokens
    - (usage.cacheCreation5mTokens ?? 0)
    - (usage.cacheCreation1hTokens ?? 0)
    - (usage.cacheReadTokens ?? 0)
    - (usage.cachedInputTokens ?? 0);
  const inputMicros = BigInt(Math.max(0, billableInputTokens)) * pricing.inputPerMillionMicros / microsPerMillion;
  const outputMicros = BigInt(usage.outputTokens) * pricing.outputPerMillionMicros / microsPerMillion;
  const totalMicros = inputMicros + outputMicros + cache5mMicros + cache1hMicros + cacheReadMicros + cachedInputMicros;
  return {
    totalCost: Number(totalMicros) / 1_000_000,
    breakdown: {
      input: Number(inputMicros) / 1_000_000,
      output: Number(outputMicros) / 1_000_000,
      cacheCreation: Number(cache5mMicros + cache1hMicros) / 1_000_000,
      cacheRead: Number(cacheReadMicros) / 1_000_000,
      cachedInput: Number(cachedInputMicros) / 1_000_000,
    },
  };
}
```

### 11.3 Two-stage billing (X8 + sub2api `usage_logs`)

```ts
// apps/gateway/src/runtime/usageLogging.ts (modify)
async function emitUsageLog(input: EmitUsageInput, deps: Deps) {
  const account = input.account;
  const groupCtx = input.groupCtx;

  let totalCost = 0;
  let breakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cachedInput: 0 };
  let eventTypeSuffix = '';

  if (account.type === 'oauth') {
    // X11 — subscription, no per-token cost
    eventTypeSuffix = '_subscription';
  } else {
    // apikey — priced via lookup
    const pricing = await deps.pricingLookup.lookup(account.platform, input.model, new Date());
    if (!pricing) {
      eventTypeSuffix = '_unpriced';
    } else {
      const computed = computeCost(pricing, input.usage);
      totalCost = computed.totalCost;
      breakdown = computed.breakdown;
    }
  }

  // Two-stage: total_cost = raw, actual_cost = applied to user
  const rateMultiplier = groupCtx?.rateMultiplier ?? 1.0;
  const actualCost = totalCost * rateMultiplier;

  await db.insert(llmUsageEvents).values({
    orgId: input.orgId,
    eventType: `gateway_request${eventTypeSuffix}`,
    platform: account.platform,
    accountId: account.id,
    groupId: groupCtx?.groupId,
    model: input.model,
    tokensInput: input.usage.inputTokens,
    tokensOutput: input.usage.outputTokens,
    cacheCreation5mTokens: input.usage.cacheCreation5mTokens ?? 0,
    cacheCreation1hTokens: input.usage.cacheCreation1hTokens ?? 0,
    cacheReadTokens: input.usage.cacheReadTokens ?? 0,
    cachedInputTokens: input.usage.cachedInputTokens ?? 0,
    costUsd: totalCost.toFixed(6),
    cacheCreationCost: breakdown.cacheCreation.toFixed(10),
    cacheReadCost: breakdown.cacheRead.toFixed(10),
    actualCostUsd: actualCost.toFixed(6),
    refType: 'gateway_request',
    refId: input.requestId,
    durationMs: input.durationMs,
    stream: input.streamed,
  });

  // Budget enforcement only on metered (apikey) calls
  if (totalCost > 0) {
    await deps.enforceBudget(input.orgId, totalCost);
  }
}
```

### 11.4 Pricing seed maintenance

Future price changes ship as new migrations:
- New row with `effective_from = <change date>`
- Previous row UPDATEd to set `effective_to = <change date>`
- Lookup at `change date - 1ms` returns old row; at `change date` returns new row

---

## 12. ImpersonateChrome (subscription metadata only)

Per cross-cutting decisions X9 + X10. Used **only** to fetch ChatGPT subscription `plan_type` and quota for OAuth accounts; NOT in inference hot path.

### 12.1 Why needed

OpenAI's standard `/v1/me` endpoint exists for API keys but not for ChatGPT subscription tokens. To get `plan_type` (Plus/Pro/Enterprise/Team), we must call `https://chatgpt.com/backend-api/me`. This endpoint sits behind Cloudflare with TLS fingerprint detection; standard `fetch` from Node returns 403.

### 12.2 Library choice (decision A8)

Two options:

**Option A — npm `node-tls-fingerprint` (or equivalent)**:
- Pure Node.js, no external binary
- Library maintenance concern (less mature than Go ecosystem)
- Lower friction for users

**Option B — Go sidecar binary (e.g., bundled small `aide-impersonate` binary)**:
- Reuses sub2api's exact `req` library (battle-tested)
- More moving parts (binary + IPC)
- Higher friction

**Decision: A** at impl time — try `node-tls-fingerprint` first; if it fails consistently in CI, switch to **B** (Go sidecar; ship as separate Docker stage).

### 12.3 Usage points

```ts
// apps/gateway/src/oauth/openai/fetchPlanType.ts (NEW)
export async function fetchPlanType(accessToken: string): Promise<{ planType: string | null; raw: any }> {
  try {
    const client = createImpersonateChromeClient();
    const res = await client.get('https://chatgpt.com/backend-api/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { planType: null, raw: { http: res.status } };
    const data = await res.json();
    // Map sub2api conventions: data.plan_type = 'plus' | 'pro' | 'enterprise' | 'team' | null
    return { planType: data.plan_type ?? null, raw: data };
  } catch (err) {
    return { planType: null, raw: { error: String(err) } };
  }
}
```

Called in two places:

1. **Account creation** (per A19 — opt-in, can skip): if admin chose to detect tier instead of manual fill, gateway calls `fetchPlanType` after OAuth completes; result populates `subscription_tier`
2. **Periodic refresh** (background scheduler, daily): re-fetches plan_type for all OAuth OpenAI accounts; updates `subscription_tier` if changed (e.g., admin upgraded ChatGPT Plus → Pro)

### 12.4 Failure handling

If `fetchPlanType` returns `planType: null`:
- Account still works for inference (hot path doesn't depend on tier)
- Admin UI shows "tier unknown" badge
- Admin can manually set `subscription_tier` via update UI
- Logged as `gw_oauth_plan_type_fetch_failed{platform="openai"}` metric

### 12.5 Quota fetch (future extension, not 5A)

sub2api also calls `chatgpt.com/backend-api/conversation_limits` to get remaining quota. 5A defers this to a follow-up; 5A only fetches `plan_type` (one-time + daily refresh). Quota visibility added in 5B or post-5A patch.

---

## 13. Admin UI

### 13.1 New pages

- `/admin/account-groups` — list, create, edit, delete groups; assign accounts to groups
- `/admin/account-groups/[id]` — group detail; member account table; rate_multiplier setting; isExclusive toggle
- `/admin/oauth-flow` — modal triggered from account creation; device-code flow countdown + cancel
- `/admin/cost-dashboard` (extend 4C) — per-platform breakdown; group-level views

### 13.2 AddAccountDialog flow extension

```
Step 1: Pick group (or create new)
   └─ if creating: set name + platform (immutable)

Step 2: Pick account type
   ├─ OAuth (subscription) — opens device-flow modal
   └─ API key — paste sk-... key

Step 3 (OAuth path):
   ├─ Choose detect-tier-or-manual
   │   ├─ detect: server calls fetchPlanType after OAuth; populates tier
   │   └─ manual: admin picks tier from dropdown
   └─ Modal opens browser → admin completes login → callback → success

Step 3 (API key path):
   ├─ Paste key
   ├─ [Test] button calls /v1/me with the key (OpenAI) or equivalent
   └─ [Save] → vault row + upstream_account row + auto-add to chosen group
```

### 13.3 Account list extensions

Existing `AccountsTable` (4A) gains columns:
- `Group` — comma-separated group names (account can be in multiple)
- `Tier` — subscription tier (for OAuth) or "—" (for API key)
- `Platform` — already exists; add icon + filter

### 13.4 API key creation flow

When admin creates a new gateway-issued API key:
- New required field: `Group` (dropdown of org's groups)
- Existing keys with `group_id = NULL` (legacy) shown with badge "legacy — assign to a group"
- Re-assign button moves an existing key to a different group

### 13.5 Cost dashboard updates

```
┌─ LLM Spend (May 2026) ─────────────────────────────────┐
│ Total: $52.40 / $200.00 (26%)                          │
│                                                         │
│ By group / platform:                                    │
│   anthropic-prod (anthropic, oauth):  $0.00 (subscription)│
│   anthropic-overflow (anthropic, apikey): $12.30       │
│   openai-pool (openai, oauth):        $0.00 (subscription)│
│   openai-overflow (openai, apikey):   $40.10           │
│                                                         │
│ Top models:                                             │
│   gpt-4o:               $35.20  (apikey only)          │
│   claude-sonnet-4-6:    $12.30  (apikey only)          │
│   claude-haiku-4-5:     $4.90   (apikey only)          │
│   o1-mini:              $0.00   (subscription only)    │
│                                                         │
│ Subscription utilisation:                               │
│   anthropic Pro: ~78% used (3 days remaining in cycle) │
│   openai Pro: ~45% used (10 days remaining)            │
└─────────────────────────────────────────────────────────┘
```

Subscription utilisation block requires `plan_type` + `quota` data; if unavailable, show "tier unknown".

---

## 14. Test plan

### 14.1 Unit tests (per package)

| Module | Tests added | Approx count |
|---|---|---|
| `@aide/gateway-core` body translators (4 new + tweaks to existing) | mapping per direction × 8-15 cases | 50+ |
| `@aide/gateway-core` stream translators (6 new) | snapshot per direction × 10+ scenarios | 60+ |
| `@aide/gateway-core` stop-reason map | exhaustive | 6 |
| `@aide/evaluator` cost lookup + compute | seed lookup, time range, cache, cache pricing classes | 12 |
| `apps/gateway` resolveGroupContext | legacy / valid / disabled / cross-platform | 6 |
| `apps/gateway` autoRoute dispatch | each platform × each route | 9 |
| `apps/gateway` 3-layer scheduler | per-layer happy + miss + edge | 15 |
| `apps/gateway` EWMA tracking | record/score, NaN init, decay | 6 |
| `apps/gateway` OAuth registry | dispatch by platform | 4 |
| `apps/gateway` openaiOAuth | initiate / exchange / refresh / refresh-rotation / failure modes | 8 |
| `apps/gateway` OAuthRefreshAPI | lock arbitration, policy effects, race | 8 |
| `apps/gateway` fetchPlanType | success, 403, network error, missing field | 5 |
| `apps/gateway` cost emission | oauth=0, apikey priced, rate_multiplier applied | 6 |

### 14.2 Integration tests

- Migration 0008/0009/0010 apply + reverse cleanly
- Pricing seed validation (7 rows, columns valid)
- Group creation + account assignment + API key linking end-to-end
- OAuth account creation with mocked OpenAI + ImpersonateChrome
- Refresh-token rotation race (two concurrent refreshes)
- Failover within group across `oauth + apikey` accounts (X7 type-agnostic)
- Auto-route: same `/v1/messages` request gives anthropic vs openai response based on group
- 3-layer scheduler: previous_response_id sticky → session_hash sticky → load_balance fallback
- Codex CLI smoke (mock its UA + headers; verify `/backend-api/codex/responses` works)

### 14.3 E2E (Playwright)

- `apps/web/e2e/specs/40-account-groups.spec.ts` — create group, add accounts, assign to API key
- `apps/web/e2e/specs/41-openai-oauth-flow.spec.ts` — admin walks through 4-step wizard with mocked OpenAI
- `apps/web/e2e/specs/42-cross-format-streaming.spec.ts` — Claude Code client → OpenAI upstream
- `apps/web/e2e/specs/43-failover-cross-type.spec.ts` — OAuth account 429 → API key fallback

### 14.4 Stream contract tests (weekly CI)

- Real OpenAI sk-key + real Claude OAuth (CI secrets)
- Each translator direction makes one round-trip
- Snapshot comparison against committed fixtures
- Alert on shape change

### 14.5 Codex CLI smoke (weekly + manual)

`scripts/smoke-codex-cli.sh`:
- Boots gateway in container with test group
- Runs `@openai/codex` CLI with `OPENAI_BASE_URL=$GATEWAY_URL`, `OPENAI_API_KEY=$GATEWAY_KEY`
- Issues "write hello world" prompt
- Asserts non-empty response
- Posts alert + opens GitHub issue on failure

### 14.6 Coverage targets

- `@aide/gateway-core` ≥ 85% (translators + stream)
- `apps/gateway/src/oauth/*` ≥ 90%
- `apps/gateway/src/runtime/scheduler.ts` ≥ 85%
- Overall repo ≥ 80% (existing target)

---

## 15. Rollout (PR sequence)

5A is large; split into reviewable PRs. Suggested order:

| PR | Scope | Behind flag? | Notes |
|---|---|---|---|
| 1 | Migration 0008 (account_groups + api_keys.group_id + subscription_tier) + Drizzle schema + backfill test | yes | Schema-only; legacy 4A behaviour unchanged |
| 2 | Migration 0009 (model_pricing) + seed + Drizzle | yes | Refactor `pricing.ts` to use lookup |
| 3 | Migration 0010 (llm_usage_events extension) + cost emission update | yes | Two-stage cost; existing 4C cost paths unaffected |
| 4 | OAuth abstraction (4-piece interface, registry, RefreshPolicy table) | yes | No behaviour change; only refactor scaffolding |
| 5 | OpenAI OAuth implementation (Codex constants, service, refresher, provider) | yes | OAuth flow exists but unused in routes |
| 6 | Body + stream translators (6 new directions) — pure functions | yes | No runtime wiring |
| 7 | 3-layer scheduler (replaces single-layer failoverLoop) | yes | Internal change; existing tests updated |
| 8 | Group context middleware + autoRoute dispatch | yes | Plumbing; routes still passthrough by default |
| 9 | OpenAI route handlers (`/v1/responses` new + chatCompletions update + messages auto-route) | yes | Activates surface when group platform = openai |
| 10 | ImpersonateChrome + fetchPlanType + admin UI for tier | yes | Optional feature |
| 11 | Admin UI (account groups CRUD + AddAccountDialog OAuth flow + cost dashboard breakdown) | yes | Final user-visible surface |
| 12 | E2E + smoke + docs (UPGRADE-v0.6.0.md, runbooks, README) | yes | Documentation + acceptance |

PRs 1-10 are invisible to end users (flag-gated). PR 11 makes admin UI visible. PR 12 closes the release.

### 15.1 Pre-merge checks per PR

- CI green (typecheck, unit, integration, e2e where relevant)
- Coverage delta non-negative
- Migration up/down round-trip verified
- Snapshot fixtures reviewed (PRs 6, 7)

### 15.2 Smoke checklist (before tag v0.6.0)

- [ ] `ENABLE_OPENAI_PROVIDER=true` on self-org
- [ ] OAuth account creation: ChatGPT Plus + Pro accounts via device flow (manual)
- [ ] API key account creation: at least one OpenAI sk-key
- [ ] Group creation + member assignment + API key binding
- [ ] Smoke each route × upstream combination:
  - [ ] `/v1/messages` + anthropic group → Anthropic upstream (regression)
  - [ ] `/v1/messages` + openai group → OpenAI Responses upstream (cross-format)
  - [ ] `/v1/chat/completions` + anthropic group → Anthropic (with streaming, completes 4A Part 6.7 TODO)
  - [ ] `/v1/chat/completions` + openai group → OpenAI Chat (passthrough)
  - [ ] `/v1/responses` + openai group → OpenAI Responses (Codex CLI native)
  - [ ] `/v1/responses` + anthropic group → Anthropic via translation
  - [ ] `/backend-api/codex/responses` always → OpenAI handler
- [ ] Failover within OpenAI group: 429 OAuth account → fallback to API key
- [ ] Cost dashboard shows correct per-group + per-platform breakdown
- [ ] OAuth account: subscription_tier visible (or "tier unknown" if ImpersonateChrome failed)
- [ ] Codex CLI smoke green
- [ ] Stream contract tests passing
- [ ] No new error-rate spike for 24h

### 15.3 Tag v0.6.0

After all smoke items green:
- Tag `v0.6.0` on main
- Docker images built + pushed
- `docs/UPGRADE-v0.6.0.md` finalised
- Release notes published
- Open Plan 5B (Gemini) handoff doc

### 15.4 Rollback

Three-tier per main pattern:
- **Tier 1**: `ENABLE_OPENAI_PROVIDER=false` — disables OpenAI code path; existing accounts unchanged
- **Tier 2**: schema rollback in reverse order (0010_down → 0009_down → 0008_down); requires no openai accounts to exist
- **Tier 3**: `git revert` 5A commits + redeploy v0.5.x image

---

## 16. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | OpenAI revokes Codex CLI public client_id (`app_EMoamEEZ73f0CkXaXp7hrann`) | Low | High | Vendoring runbook; CLI itself would also break; community would notice instantly; fall back to API key flow |
| R2 | Codex CLI auth flow changes (e.g., new endpoint, new PKCE params) | Medium | High | Weekly contract test; vendoring runbook; isolated module limits blast radius |
| R3 | ImpersonateChrome library (Node) breaks under Cloudflare update | Medium | Low | Plan_type fetch is opt-in; degrades to "tier unknown"; doesn't break inference |
| R4 | Group migration backfill fails on production data | Low | High | Migration 0008 has DO block with error capture; test on staging snapshot first |
| R5 | 3-layer scheduler regression breaks existing Anthropic load balancing | Medium | High | Extensive snapshot tests of scheduler decisions; sticky session bound to existing 4A session-id mechanism |
| R6 | Stream translator state machine bug → malformed SSE to client | Medium | High | Property tests assert always-parseable output; integration tests with real fixtures |
| R7 | Cross-format pivot (chat ↔ responses via anthropic) loses fidelity | Medium | Low | Document in upgrade guide; emit warning header on pivot |
| R8 | OAuth refresh token rotation race | Low | Low | Single-SQL-UPDATE replaceTokens + Redis lock; concurrent refreshes both produce valid tokens |
| R9 | OpenAI 400 invalid_request for translated body | Medium | Medium | Body translators validate output via Zod; integration tests run real bodies through real upstream weekly |
| R10 | `model_pricing` cache staleness when prices change | Low | Low | 5-min TTL; cache `invalidate` exposed; new-row migrations infrequent |
| R11 | Admin creates many OAuth accounts → device flow Redis pressure | Low | Low | 15-min TTL on flow keys; per-admin rate limit 5/min on initiate |
| R12 | OAuth token leak via log lines | Low | High | All refresh paths use `redact()` helper; security review before merge |
| R13 | Localhost:1455 port collision with admin's other tools | Medium | Low | Detect port-in-use at gateway start; log warning + skip OAuth listener; admin can use external helper |
| R14 | sub2api architecture mismatches ai-dev-eval's tRPC + Drizzle stack | Medium | Medium | Sub-design ports concepts not code; impl review at each PR |

---

## 17. Open items (locked during impl plan)

These are intentionally vague; impl plan resolves:

- ImpersonateChrome library final choice (A8 — `node-tls-fingerprint` vs Go sidecar)
- Exact pricing seed values — recheck against provider pages at PR review
- OpenAI rate-limit header names — verify current API
- UI copy for OAuth modal (especially error states; multi-locale)
- Codex CLI smoke test fixture (prompt + expected response shape)
- Subscription tier hint table (informational rate limits per tier; updated when OpenAI changes plans)
- Whether to ship a small `aide-oauth-callback` standalone helper as escape hatch for R13

---

## 18. Reference files

### sub2api source (reference architecture)

- `internal/domain/constants.go:21-32` — Platform / AccountType constants
- `internal/server/routes/gateway.go:44-150` — Route table + auto-dispatch
- `internal/service/openai_account_scheduler.go:242-310` — 3-layer scheduler
- `internal/service/wire.go:55-130` — DI for 4-piece OAuth pattern
- `internal/service/refresh_policy.go` — Per-platform RefreshPolicy
- `internal/pkg/openai/oauth.go:19` — OpenAI Codex client_id
- `internal/pkg/geminicli/constants.go:36-41` — Gemini CLI client_id (5B reference)
- `internal/pkg/antigravity/oauth.go` — Antigravity client_id (5C reference)
- `internal/service/openai_oauth_service.go:20` — ImpersonateChrome usage
- `internal/service/quota_fetcher.go` — QuotaFetcher interface
- `internal/service/gemini_quota.go` — Gemini tier-based quota model (5B reference)
- `migrations/001_init.sql` — Schema baseline (accounts, groups, account_groups, usage_logs)
- `internal/service/gateway_request.go GenerateSessionHash` — Session hash priority logic

### ai-dev-eval files (touched by 5A)

**New files:**
- `apps/gateway/src/oauth/types.ts` — interfaces
- `apps/gateway/src/oauth/registry.ts` — provider registry
- `apps/gateway/src/oauth/policies.ts` — RefreshPolicy per platform
- `apps/gateway/src/oauth/refreshApi.ts` — unified `OAuthRefreshAPI`
- `apps/gateway/src/oauth/pkce.ts` — PKCE helpers
- `apps/gateway/src/oauth/openai/openaiCodexConstants.ts` — vendored constants
- `apps/gateway/src/oauth/openai/openaiOAuthService.ts` — interactive flow
- `apps/gateway/src/oauth/openai/openaiTokenRefresher.ts` — refresh executor
- `apps/gateway/src/oauth/openai/openaiTokenProvider.ts` — hot-path provider
- `apps/gateway/src/oauth/openai/fetchPlanType.ts` — ImpersonateChrome plan fetch
- `apps/gateway/src/oauth/backgroundScheduler.ts` — daily refresh + tier sync
- `apps/gateway/src/runtime/groupDispatch.ts` — `resolveGroupContext`
- `apps/gateway/src/runtime/scheduler.ts` — 3-layer scheduler
- `apps/gateway/src/middleware/groupContext.ts` — `req.gwGroupContext` plug
- `apps/gateway/src/routes/dispatch.ts` — `autoRoute` helper
- `apps/gateway/src/routes/responses.ts` — `/v1/responses` handler (Anthropic-group path translates to Messages)
- `apps/gateway/src/routes/codexResponses.ts` — `/backend-api/codex/responses` Codex CLI alias
- `packages/gateway-core/src/translate/responsesToAnthropic.ts` (and inverse) — body
- `packages/gateway-core/src/translate/chatToResponses.ts` (and inverse) — pivot
- `packages/gateway-core/src/translate/stopReasonMap.ts`
- `packages/gateway-core/src/translate/dispatch.ts`
- `packages/gateway-core/src/translate/stream/*.ts` — 6 stream translators + pipe wrapper
- `packages/db/src/schema/accountGroups.ts`
- `packages/db/src/schema/modelPricing.ts`
- `packages/db/drizzle/0008_*.sql`, `0009_*.sql`, `0010_*.sql`
- `apps/api/src/trpc/routers/admin/accountGroups.ts`
- `apps/api/src/trpc/routers/admin/oauth.ts`
- `apps/web/src/components/admin/AccountGroupsTable.tsx`
- `apps/web/src/components/admin/OAuthDeviceFlowModal.tsx`
- `apps/web/src/data/openaiTierLimits.ts`
- `apps/web/e2e/specs/40-account-groups.spec.ts`, `41-openai-oauth-flow.spec.ts`, `42-cross-format-streaming.spec.ts`, `43-failover-cross-type.spec.ts`
- `scripts/smoke-codex-cli.sh`
- `docs/runbooks/openai-oauth-vendor-update.md`
- `docs/runbooks/openai-oauth-reauth.md`
- `docs/UPGRADE-v0.6.0.md`

**Modified files:**
- `packages/db/src/schema/accounts.ts` — add `subscriptionTier`
- `packages/db/src/schema/apiKeys.ts` — add `groupId`
- `packages/db/src/schema/llmUsageEvents.ts` — add new columns
- `apps/gateway/src/runtime/upstreamCall.ts` — provider switch (anthropic vs openai)
- `apps/gateway/src/runtime/failoverLoop.ts` — replaced by scheduler (or wraps it)
- `apps/gateway/src/runtime/oauthRefresh.ts` — anthropic-only stays (5D refactor later)
- `apps/gateway/src/runtime/usageLogging.ts` — two-stage cost
- `apps/gateway/src/runtime/streamUsageExtractor.ts` — per-provider variants
- `apps/gateway/src/routes/messages.ts` — wraps with autoRoute
- `apps/gateway/src/routes/chatCompletions.ts` — completes Part 6.7 streaming + autoRoute
- `apps/gateway/src/server.ts` — register new routes
- `packages/evaluator/src/cost/pricing.ts` — refactor to DB lookup
- `packages/config/src/env.ts` — `ENABLE_OPENAI_PROVIDER` flag
- `apps/web/src/components/admin/AddAccountDialog.tsx` — group + OAuth flow integration
- `apps/web/src/components/admin/AccountsTable.tsx` — group/tier columns
- `apps/web/src/components/admin/CostSummaryCard.tsx` — per-platform breakdown
- `docs/EVALUATOR.md` — multi-provider section

---

## 19. Next steps

If 5A design is approved:

1. Write `2026-04-28-plan-5a-implementation.md` (PR-by-PR task breakdown matching §15)
2. Execute PR 1 (migration 0008) on a fresh worktree `feat/plan-5a-pr1-account-groups`
3. Iterate per PR; merge after CI green + smoke checklist item complete
4. After 5A ships (v0.6.0 tag), open `2026-04-28-plan-5b-gemini-design.md` (Gemini provider; reuses 5A's group + scheduler)
5. Then 5C (Antigravity) and 5D (Anthropic OAuth refactor)






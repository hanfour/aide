# Plan 5A Implementation Plan — OpenAI Provider

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI as a peer upstream provider with OAuth ChatGPT subscription pooling primary + sk-key fallback. Three client routes (`/v1/messages` auto-route, `/v1/chat/completions`, `/v1/responses` new). Introduce Group concept + 3-layer scheduler + 4-piece OAuth pattern. Reference architecture: [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api).

**Architecture:** 12-PR rollout per design §15. Schema first (PRs 1-3), OAuth abstraction + OpenAI impl (PRs 4-5), translators (PR 6), scheduler refactor (PR 7), routing (PRs 8-9), ImpersonateChrome + admin UI (PRs 10-11), E2E + docs (PR 12). All PRs land behind `ENABLE_OPENAI_PROVIDER=false`; flag flips at v0.6.0 release.

**Tech Stack:** TypeScript (monorepo), PostgreSQL (Drizzle ORM), Redis (sticky session + OAuth flow state + locks), Vitest + Playwright, Next.js App Router, tRPC, Zod, Fastify (gateway).

**Spec:** `.claude/plans/2026-04-28-plan-5a-design.md`
**Reference architecture:** `/tmp/aide-research/sub2api` (read-only research clone)

---

## Codebase conventions

Same as 4C / 5B impl plans. Plan 5A additions:

- **Translator residency**: All body + stream translators live under `packages/gateway-core/src/translate/`. Imports from `apps/gateway` use barrel export.
- **OAuth code residency**: All OAuth providers + registry live under `apps/gateway/src/oauth/<platform>/`. Refresh hot path stays in `apps/gateway/src/runtime/oauthRefresh.ts` (legacy Anthropic path) until 5D.
- **Scheduler residency**: `apps/gateway/src/runtime/scheduler.ts` is NEW; replaces `failoverLoop.ts` as the entry point. `failoverLoop.ts` becomes a thin wrapper.
- **Migration baseline**: main is at `ab421e0` with migrations through 0007. Plan 5A starts at migration 0008.
- **`ENABLE_OPENAI_PROVIDER=false`** is the master gate; all OpenAI code paths check this. 4-layer gate per design §15.

### Worktree

- Recommended: `/Users/hanfourhuang/ai-dev-eval/.worktrees/plan-5a`
- Branch: `feat/plan-5a-openai`
- Baseline: `main` at `ab421e0` (or later when 5A starts)

---

## Plan structure

| Part | Scope | PR # | Tasks |
|------|-------|------|-------|
| 1 | Migration 0008 (account_groups + api_keys.group_id + subscription_tier) | PR 1 | 6 |
| 2 | Migration 0009 (model_pricing) + seed + pricing lookup refactor | PR 2 | 5 |
| 3 | Migration 0010 (llm_usage_events extension) + two-stage cost emission | PR 3 | 5 |
| 4 | OAuth abstraction (4-piece interfaces, registry, RefreshPolicy, OAuthRefreshAPI) | PR 4 | 8 |
| 5 | OpenAI OAuth implementation (Codex constants, service, refresher, provider, callback listener) | PR 5 | 9 |
| 6 | Body + stream translators (6 new directions) | PR 6 | 11 |
| 7 | 3-layer scheduler refactor | PR 7 | 8 |
| 8 | Group context middleware + autoRoute helper | PR 8 | 5 |
| 9 | OpenAI route handlers + Codex CLI alias + streaming completion | PR 9 | 7 |
| 10 | ImpersonateChrome + fetchPlanType + tier sync background job | PR 10 | 6 |
| 11 | Admin UI (account groups + OAuth flow modal + cost dashboard breakdown) | PR 11 | 10 |
| 12 | E2E + smoke + docs (UPGRADE-v0.6.0, runbooks, README) | PR 12 | 8 |

**Total:** 88 tasks across 12 parts.

Commits use conventional format: `feat:` / `fix:` / `docs:` / `test:` / `chore:` / `ci:`.

---

## Part 1 — Migration 0008: account_groups + api_keys.group_id + subscription_tier

**PR title:** `feat(plan-5a): account_groups schema + api_keys.group_id + subscription_tier (migration 0008)`

**PR scope:** Schema-only. Behind `ENABLE_OPENAI_PROVIDER=false`. Backfill creates `legacy-anthropic` group per org.

### Task 1.1: Drizzle schema for `account_groups` + `account_group_members`

**Files:**
- Create: `packages/db/src/schema/accountGroups.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1**: Create `accountGroups.ts` per design §4.4:

```ts
import { pgTable, uuid, text, decimal, boolean, timestamp, integer, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./org.js";
import { upstreamAccounts } from "./accounts.js";

export const accountGroups = pgTable("account_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  platform: text("platform").notNull(),
  rateMultiplier: decimal("rate_multiplier", { precision: 10, scale: 4 }).notNull().default("1.0"),
  isExclusive: boolean("is_exclusive").notNull().default(false),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const accountGroupMembers = pgTable(
  "account_group_members",
  {
    accountId: uuid("account_id").notNull().references(() => upstreamAccounts.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").notNull().references(() => accountGroups.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(50),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accountId, t.groupId] }),
  }),
);
```

- [ ] **Step 2**: Add to `index.ts` barrel export.

- [ ] **Step 3**: Typecheck:
```bash
pnpm --filter @aide/db typecheck
```

### Task 1.2: Add `groupId` to `apiKeys` schema

**Files:**
- Modify: `packages/db/src/schema/apiKeys.ts` (existing 4A)

- [ ] **Step 1**: Add column inside the pgTable column object:

```ts
groupId: uuid("group_id").references(() => accountGroups.id, { onDelete: "set null" }),
```

- [ ] **Step 2**: Import `accountGroups` from `./accountGroups.js`.

- [ ] **Step 3**: Typecheck.

### Task 1.3: Add `subscriptionTier` to `upstreamAccounts`

**Files:**
- Modify: `packages/db/src/schema/accounts.ts`

- [ ] **Step 1**: Add column:

```ts
subscriptionTier: text("subscription_tier"),
```

- [ ] **Step 2**: CHECK constraint added in migration raw SQL (Drizzle doesn't natively express).

### Task 1.4: Generate migration 0008 + hand-edit constraints + backfill

**Files:**
- Generated: `packages/db/drizzle/0008_*.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`

- [ ] **Step 1**: Generate:
```bash
pnpm --filter @aide/db db:generate
```

Drizzle output should include `CREATE TABLE account_groups`, `CREATE TABLE account_group_members`, `ALTER api_keys ADD COLUMN group_id`, `ALTER upstream_accounts ADD COLUMN subscription_tier`.

- [ ] **Step 2**: Append to generated SQL — CHECK constraints + indexes per design §4.1:

```sql
-- account_groups CHECK constraints + index
ALTER TABLE account_groups
  ADD CONSTRAINT account_groups_platform_values
  CHECK (platform IN ('anthropic', 'openai', 'gemini', 'antigravity'));

ALTER TABLE account_groups
  ADD CONSTRAINT account_groups_status_values
  CHECK (status IN ('active', 'disabled'));

ALTER TABLE account_groups
  ADD CONSTRAINT account_groups_org_name_unique
  UNIQUE (org_id, name);

CREATE INDEX account_groups_org_platform_idx
  ON account_groups (org_id, platform)
  WHERE deleted_at IS NULL;

CREATE INDEX account_group_members_group_priority_idx
  ON account_group_members (group_id, priority);

CREATE INDEX api_keys_group_idx ON api_keys (group_id) WHERE deleted_at IS NULL;

-- subscription_tier CHECK
ALTER TABLE upstream_accounts
  ADD CONSTRAINT subscription_tier_values
  CHECK (
    subscription_tier IS NULL
    OR subscription_tier IN ('free', 'plus', 'pro', 'team', 'enterprise')
  );

-- Backfill: legacy-anthropic group per org + assign existing accounts + api_keys
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

- [ ] **Step 3**: Apply locally:
```bash
pnpm --filter @aide/db db:migrate
```

### Task 1.5: Hand-write 0008_down.sql

**Files:**
- Create: `packages/db/drizzle/0008_down.sql`

- [ ] **Step 1**:

```sql
ALTER TABLE upstream_accounts
  DROP CONSTRAINT IF EXISTS subscription_tier_values,
  DROP COLUMN IF EXISTS subscription_tier;

DROP INDEX IF EXISTS api_keys_group_idx;
ALTER TABLE api_keys DROP COLUMN IF EXISTS group_id;

DROP TABLE IF EXISTS account_group_members;
DROP TABLE IF EXISTS account_groups;
```

- [ ] **Step 2**: Verify down round-trip on test DB.

### Task 1.6: Migration 0008 integration test

**Files:**
- Create: `apps/api/tests/integration/migrations/0008.test.ts`

- [ ] **Step 1**: Cases:

```ts
describe('migration 0008', () => {
  it('account_groups table exists with required columns', async () => { /* ... */ });
  it('account_group_members has composite PK', async () => { /* ... */ });
  it('api_keys.group_id column exists, nullable, FK', async () => { /* ... */ });
  it('subscription_tier CHECK rejects invalid values', async () => {
    await expect(testDb.pool.query(
      `INSERT INTO upstream_accounts (id, org_id, name, platform, type, subscription_tier) VALUES (gen_random_uuid(), $1, 'test', 'openai', 'oauth', 'invalid')`,
      [orgId]
    )).rejects.toThrow(/subscription_tier_values/);
  });
  it('account_groups platform CHECK accepts anthropic|openai|gemini|antigravity', async () => { /* ... */ });
  it('account_groups platform CHECK rejects other values', async () => { /* ... */ });
  it('backfill creates legacy-anthropic group per org', async () => {
    // Pre-create org + anthropic account, run migration, verify group + member rows
  });
  it('backfill assigns api_keys to legacy-anthropic group', async () => { /* ... */ });
  it('down migration reverses cleanly', async () => { /* ... */ });
});
```

- [ ] **Step 2**: Run:
```bash
pnpm --filter @aide/api test:integration -- migrations/0008
```

- [ ] **Step 3**: All 9 cases green.

---

## Part 2 — Migration 0009: model_pricing + seed + pricing lookup refactor

**PR title:** `feat(plan-5a): model_pricing table + Anthropic/OpenAI pricing seed (migration 0009)`

**PR scope:** Schema + seed + refactor `pricing.ts` to DB lookup. Behind flag.

### Task 2.1: Drizzle schema for `modelPricing`

**Files:**
- Create: `packages/db/src/schema/modelPricing.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1**: Schema per design §4.4:

```ts
import { pgTable, uuid, text, bigint, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const modelPricing = pgTable(
  "model_pricing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platform: text("platform").notNull(),
    modelId: text("model_id").notNull(),
    inputPerMillionMicros: bigint("input_per_million_micros", { mode: "bigint" }).notNull(),
    outputPerMillionMicros: bigint("output_per_million_micros", { mode: "bigint" }).notNull(),
    cached5mPerMillionMicros: bigint("cached_5m_per_million_micros", { mode: "bigint" }),
    cached1hPerMillionMicros: bigint("cached_1h_per_million_micros", { mode: "bigint" }),
    cachedInputPerMillionMicros: bigint("cached_input_per_million_micros", { mode: "bigint" }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeIdx: uniqueIndex("model_pricing_active_idx").on(t.platform, t.modelId, t.effectiveFrom),
    lookupIdx: index("model_pricing_lookup_idx").on(t.platform, t.modelId, t.effectiveFrom),
  }),
);
```

- [ ] **Step 2**: Barrel export.

### Task 2.2: Pricing seed file

**Files:**
- Create: `packages/db/src/seed/modelPricingSnapshot2026Q2.ts`

- [ ] **Step 1**: Centralised constants (cite source URLs in comment):

```ts
/**
 * Model pricing snapshot — 2026-04-28
 *
 * Sources (verify at PR review):
 * - Anthropic: anthropic.com/pricing as of 2026-04-28
 *   - Prompt cache 5min vs 1h pricing per docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 * - OpenAI: openai.com/pricing as of 2026-04-28
 *
 * Units: micros per million tokens (1 USD = 1_000_000 micros).
 *   So $3 per 1M tokens → 3_000_000 micros per million tokens.
 *
 * Future price changes: ship as new migration with effective_to set on previous rows.
 */
export const MODEL_PRICING_SNAPSHOT_2026_04_28 = [
  // Anthropic
  { platform: 'anthropic', modelId: 'claude-opus-4-7',     input: 15_000_000n, output: 75_000_000n, cached5m: 18_750_000n, cached1h: 30_000_000n, cachedInput: null },
  { platform: 'anthropic', modelId: 'claude-sonnet-4-6',    input:  3_000_000n, output: 15_000_000n, cached5m:  3_750_000n, cached1h:  6_000_000n, cachedInput: null },
  { platform: 'anthropic', modelId: 'claude-haiku-4-5',     input:  1_000_000n, output:  5_000_000n, cached5m:  1_250_000n, cached1h:  2_000_000n, cachedInput: null },
  // OpenAI
  { platform: 'openai',    modelId: 'gpt-4o',               input:  2_500_000n, output: 10_000_000n, cached5m: null, cached1h: null, cachedInput:  1_250_000n },
  { platform: 'openai',    modelId: 'gpt-4o-mini',          input:    150_000n, output:    600_000n, cached5m: null, cached1h: null, cachedInput:     75_000n },
  { platform: 'openai',    modelId: 'o1',                   input: 15_000_000n, output: 60_000_000n, cached5m: null, cached1h: null, cachedInput:  7_500_000n },
  { platform: 'openai',    modelId: 'o1-mini',              input:  3_000_000n, output: 12_000_000n, cached5m: null, cached1h: null, cachedInput:  1_500_000n },
] as const;
```

### Task 2.3: Generate migration 0009 + append seed

**Files:**
- Generated: `packages/db/drizzle/0009_*.sql`
- Create: `packages/db/drizzle/0009_down.sql`

- [ ] **Step 1**: Generate. Drizzle output: `CREATE TABLE model_pricing` + indexes.

- [ ] **Step 2**: Append CHECK + seed to generated SQL:

```sql
ALTER TABLE model_pricing
  ADD CONSTRAINT model_pricing_platform_values
  CHECK (platform IN ('anthropic', 'openai', 'gemini', 'antigravity'));

ALTER TABLE model_pricing
  ADD CONSTRAINT model_pricing_effective_range
  CHECK (effective_to IS NULL OR effective_to > effective_from);

INSERT INTO model_pricing (platform, model_id, input_per_million_micros, output_per_million_micros,
  cached_5m_per_million_micros, cached_1h_per_million_micros, cached_input_per_million_micros, effective_from)
VALUES
  ('anthropic', 'claude-opus-4-7',  15000000, 75000000, 18750000, 30000000, NULL, '2026-04-28T00:00:00Z'),
  ('anthropic', 'claude-sonnet-4-6', 3000000, 15000000,  3750000,  6000000, NULL, '2026-04-28T00:00:00Z'),
  ('anthropic', 'claude-haiku-4-5',  1000000,  5000000,  1250000,  2000000, NULL, '2026-04-28T00:00:00Z'),
  ('openai',    'gpt-4o',            2500000, 10000000, NULL, NULL, 1250000, '2026-04-28T00:00:00Z'),
  ('openai',    'gpt-4o-mini',        150000,   600000, NULL, NULL,   75000, '2026-04-28T00:00:00Z'),
  ('openai',    'o1',               15000000, 60000000, NULL, NULL, 7500000, '2026-04-28T00:00:00Z'),
  ('openai',    'o1-mini',           3000000, 12000000, NULL, NULL, 1500000, '2026-04-28T00:00:00Z');
```

- [ ] **Step 3**: PR review must verify each row against provider pricing pages (cite URLs in PR description).

- [ ] **Step 4**: Hand-write `0009_down.sql`:
```sql
DROP TABLE IF EXISTS model_pricing;
```

### Task 2.4: Refactor `pricing.ts` to DB lookup

**Files:**
- Modify: `packages/evaluator/src/cost/pricing.ts` (4C existing)
- Create: `packages/evaluator/src/cost/computeCost.ts`

- [ ] **Step 1**: Replace constant table with `PricingLookup` interface per design §11.1.

- [ ] **Step 2**: Implement `createPricingLookup(db, opts)` with 5-min in-process cache (Map-based with TTL).

- [ ] **Step 3**: Implement `computeCost` per design §11.2 — handles 4 token classes (input, output, cache_creation 5m/1h, cache_read, cached_input). BigInt math; null-pricing graceful.

- [ ] **Step 4**: Backwards-compat: 4C callsites that used `pricing.calculateCost(model, tokens)` updated to call `pricingLookup.lookup(...)` then `computeCost(...)`.

- [ ] **Step 5**: Tests cover: lookup hit/miss, cache TTL, time-range query, null-cached pricing, 4 token combinations.

### Task 2.5: Migration 0009 integration test

**Files:**
- Create: `apps/api/tests/integration/migrations/0009.test.ts`

- [ ] **Step 1**: Cases:
  - Table exists with all columns
  - Seed inserts 7 rows (3 anthropic + 4 openai)
  - Anthropic rows have non-null cached_5m/1h, null cached_input
  - OpenAI rows have null cached_5m/1h, non-null cached_input
  - Platform CHECK rejects invalid value
  - Effective range CHECK rejects effective_to <= effective_from
  - Lookup at `effective_from - 1ms` returns null; at `effective_from` returns the row
  - Down migration drops table cleanly

---

## Part 3 — Migration 0010: llm_usage_events extension + two-stage cost emission

**PR title:** `feat(plan-5a): llm_usage_events 4 token classes + actual_cost two-stage billing (migration 0010)`

**PR scope:** Additive schema extension + cost emission update. Behind flag for cost-affecting paths; existing 4C cost emission unaffected.

### Task 3.1: Extend `llmUsageEvents` Drizzle schema

**Files:**
- Modify: `packages/db/src/schema/llmUsageEvents.ts` (4C existing)

- [ ] **Step 1**: Add columns inside pgTable:

```ts
cacheCreation5mTokens: integer("cache_creation_5m_tokens").notNull().default(0),
cacheCreation1hTokens: integer("cache_creation_1h_tokens").notNull().default(0),
cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
cacheCreationCost: decimal("cache_creation_cost", { precision: 20, scale: 10 }).notNull().default("0"),
cacheReadCost: decimal("cache_read_cost", { precision: 20, scale: 10 }).notNull().default("0"),
actualCostUsd: decimal("actual_cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
platform: text("platform"),
accountId: uuid("account_id").references(() => upstreamAccounts.id, { onDelete: "set null" }),
groupId: uuid("group_id").references(() => accountGroups.id, { onDelete: "set null" }),
durationMs: integer("duration_ms"),
stream: boolean("stream").notNull().default(false),
```

- [ ] **Step 2**: Add indexes:

```ts
(t) => ({
  // ... existing
  accountIdx: index("llm_usage_events_account_idx").on(t.accountId, t.createdAt),
  groupIdx: index("llm_usage_events_group_idx").on(t.groupId, t.createdAt),
  platformIdx: index("llm_usage_events_platform_idx").on(t.platform, t.createdAt),
}),
```

### Task 3.2: Generate migration 0010 + hand-write down

**Files:**
- Generated: `packages/db/drizzle/0010_*.sql`
- Create: `packages/db/drizzle/0010_down.sql`

- [ ] **Step 1**: Generate. Drizzle should produce `ALTER TABLE` ADDs + CREATE INDEXs.

- [ ] **Step 2**: Hand-write `0010_down.sql`:

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

### Task 3.3: Update `usageLogging.ts` cost emission

**Files:**
- Modify: `apps/gateway/src/runtime/usageLogging.ts` (4C existing)

- [ ] **Step 1**: Per design §11.3 — two-stage cost (total_cost = raw, actual_cost = ×rate_multiplier):

```ts
async function emitUsageLog(input: EmitUsageInput, deps: Deps) {
  const account = input.account;
  const groupCtx = input.groupCtx;

  let totalCost = 0;
  let breakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cachedInput: 0 };
  let eventTypeSuffix = "";

  if (account.type === "oauth") {
    eventTypeSuffix = "_subscription";
  } else {
    const pricing = await deps.pricingLookup.lookup(account.platform, input.model, new Date());
    if (!pricing) {
      eventTypeSuffix = "_unpriced";
    } else {
      const computed = computeCost(pricing, input.usage);
      totalCost = computed.totalCost;
      breakdown = computed.breakdown;
    }
  }

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
    refType: "gateway_request",
    refId: input.requestId,
    durationMs: input.durationMs,
    stream: input.streamed,
  });

  if (totalCost > 0) {
    await deps.enforceBudget(input.orgId, totalCost);
  }
}
```

- [ ] **Step 2**: Existing 4C tests run unchanged (defaults are 0; behaviour preserved when no group context).

### Task 3.4: Unit tests for cost emission

**Files:**
- Create: `apps/gateway/tests/runtime/usageLogging.test.ts`

- [ ] **Step 1**: Cases:
  - OAuth account: `cost_usd=0`, `event_type='gateway_request_subscription'`, `actual_cost=0`, no budget enforcement
  - Unknown model: `event_type='gateway_request_unpriced'`, cost=0
  - Known anthropic apikey + cache 5m tokens: cost = input + output + cache_5m (verify breakdown)
  - Known openai apikey + cached input: cost = input (only billable portion) + output + cached_input
  - With groupCtx.rateMultiplier=1.5: actual_cost = total_cost × 1.5
  - Without groupCtx: rateMultiplier defaults to 1.0
  - Budget enforced only when totalCost > 0

### Task 3.5: Migration 0010 integration test

**Files:**
- Create: `apps/api/tests/integration/migrations/0010.test.ts`

- [ ] **Step 1**: Cases:
  - All new columns exist with correct defaults
  - Existing 4C rows still readable (defaults backfilled)
  - 3 indexes created
  - Down migration reverses cleanly without losing pre-existing 4C rows

---

## Part 4 — OAuth abstraction (4-piece interfaces, registry, RefreshPolicy, OAuthRefreshAPI)

**PR title:** `feat(plan-5a): OAuth 4-piece abstraction (registry + RefreshPolicy + OAuthRefreshAPI)`

**PR scope:** Pure scaffolding. No platform implementation. Anthropic continues using existing 4A `oauthRefresh.ts` (refactor in 5D). Behind flag.

### Task 4.1: Define 4-piece interfaces + types

**Files:**
- Create: `apps/gateway/src/oauth/types.ts`

- [ ] **Step 1**: Per design §7.1 — `OAuthService`, `TokenProvider`, `TokenRefresher`, `RefreshPolicy`, `TokenSet`, error classes.

- [ ] **Step 2**: Export `Platform` type re-export from `@aide/db`:

```ts
export type Platform = 'anthropic' | 'openai' | 'gemini' | 'antigravity';
```

### Task 4.2: PKCE helpers

**Files:**
- Create: `apps/gateway/src/oauth/pkce.ts`
- Create: `apps/gateway/src/oauth/pkce.test.ts`

- [ ] **Step 1**: Per design §6.4:

```ts
import { createHash, randomBytes } from "node:crypto";

export function generatePKCEVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return sha256Base64Url(verifier);
}
```

- [ ] **Step 2**: Tests:
  - Verifier is base64url (no padding, URL-safe alphabet, 43+ chars)
  - sha256 is deterministic
  - generateCodeChallenge follows RFC 7636

### Task 4.3: RefreshPolicy table

**Files:**
- Create: `apps/gateway/src/oauth/policies.ts`

- [ ] **Step 1**: Per design §7.2 — 4 platform policies (Anthropic + OpenAI tolerant; Gemini + Antigravity strict).

- [ ] **Step 2**: Export `getPolicy(platform: Platform): RefreshPolicy`.

### Task 4.4: OAuth provider registry

**Files:**
- Create: `apps/gateway/src/oauth/registry.ts`

- [ ] **Step 1**: Per design §7.3 stub:

```ts
export type OAuthRegistry = {
  services: Partial<Record<Platform, OAuthService>>;
  refreshers: Partial<Record<Platform, TokenRefresher>>;
  providers: Partial<Record<Platform, TokenProvider>>;
};

export function createOAuthRegistry(deps: { /* injected per platform */ }): OAuthRegistry {
  return {
    services: {
      // Anthropic stays with legacy oauthRefresh.ts in 5A; not registered here yet
      // OpenAI registered in Part 5
    },
    refreshers: {},
    providers: {},
  };
}

export function getOAuthService(registry: OAuthRegistry, platform: Platform): OAuthService {
  const svc = registry.services[platform];
  if (!svc) throw new Error(`oauth_service_not_registered_for_platform: ${platform}`);
  return svc;
}
// similarly for getRefresher, getProvider
```

### Task 4.5: Unified `OAuthRefreshAPI`

**Files:**
- Create: `apps/gateway/src/oauth/refreshApi.ts`

- [ ] **Step 1**: Per design §7.3 — orchestrates background scheduler + on-demand refresh through Redis lock. Expose `getValidAccessToken(accountId)`.

- [ ] **Step 2**: Use Redis `SET NX EX 30` for lock acquisition. On miss, honour `RefreshPolicy.onLockHeld`.

- [ ] **Step 3**: On refresh failure, honour `RefreshPolicy.onRefreshError`. `OAuthRefreshTokenInvalid` always propagates (account → oauth_invalid status).

- [ ] **Step 4**: `replaceTokens` MUST be single SQL UPDATE (atomic; rotation per design A4 + A6 in 5A design).

### Task 4.6: Background refresh scheduler

**Files:**
- Create: `apps/gateway/src/oauth/backgroundScheduler.ts`

- [ ] **Step 1**: Daily cron (or per-minute scan with 5-min lookahead per existing 4A pattern):
  - Query accounts with `expires_at - 5min < NOW` AND `status = 'active'` AND `type = 'oauth'` AND `platform IN ('anthropic', 'openai')` (gemini/antigravity in 5B/5C)
  - For each, call `oauthRefreshAPI.getValidAccessToken(accountId)` (which internally refreshes if needed)
  - On success: increment `gw_oauth_bg_refresh_success_total{platform}` metric
  - On `OAuthRefreshTokenInvalid`: account already marked invalid by `getValidAccessToken`; metric `gw_oauth_bg_refresh_invalid_total{platform}`
  - On other errors: metric `gw_oauth_bg_refresh_error_total{platform}`; honour skip policy

### Task 4.7: Vault lock + replaceTokens (extend 4A)

**Files:**
- Modify: `apps/gateway/src/credentials/vault.ts` (4A existing)

- [ ] **Step 1**: Add `replaceTokens(accountId, tokens)` method as single SQL UPDATE. Existing 4A may already have similar; verify and consolidate.

- [ ] **Step 2**: Add `peekAccessToken(accountId)` returning `{ token, expiresAt } | null`. Reads from cache → falls back to vault decrypt → falls back to null.

- [ ] **Step 3**: Per-platform HKDF domain in encryption (decision C14 in main design — `aide-oauth-anthropic-v1`, `aide-oauth-openai-v1`, etc.). Existing anthropic-only domain stays; new domain for openai.

### Task 4.8: Tests for OAuthRefreshAPI

**Files:**
- Create: `apps/gateway/src/oauth/refreshApi.test.ts`

- [ ] **Step 1**: Cases:
  - Cached token still valid → returns cached, no refresh
  - Cached token expiring soon → triggers refresh
  - Lock acquired → refresh runs, vault replaced atomically
  - Lock held by another → policy `wait_for_cache` returns updated token after wait
  - Lock held by another → policy `use_existing_token` returns cached
  - Refresh succeeds with rotation → both old + new refresh tokens valid (test atomic vault swap)
  - Refresh fails 5xx → policy tolerant uses cached
  - Refresh fails `invalid_grant` → throws `OAuthRefreshTokenInvalid` regardless of policy
  - Concurrent refresh: both callers get valid tokens; only one upstream call

---

## Part 5 — OpenAI OAuth implementation (Codex constants, service, refresher, provider, callback listener)

**PR title:** `feat(plan-5a): OpenAI Codex OAuth flow + token refresher (vendored client_id from sub2api)`

**PR scope:** OpenAI-specific implementation of the 4-piece pattern. Localhost:1455 callback listener. Behind flag.

### Task 5.1: Vendor OpenAI Codex constants

**Files:**
- Create: `apps/gateway/src/oauth/openai/openaiCodexConstants.ts`

- [ ] **Step 1**: Vendored from sub2api `internal/pkg/openai/oauth.go:19-26`:

```ts
/**
 * Vendored from sub2api repo (Wei-Shaw/sub2api),
 * which itself vendored from Codex CLI (@openai/codex npm package).
 * Source path: internal/pkg/openai/oauth.go:19-26
 * Vendored on: 2026-04-28
 * Re-vendor process: docs/runbooks/openai-oauth-vendor-update.md
 */
export const OPENAI_CODEX_OAUTH = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  defaultRedirectURI: 'http://localhost:1455/auth/callback',
  scopes: ['openid', 'email', 'profile', 'offline_access'],
  refreshScopes: 'openid email profile offline_access',
  pkceMethod: 'S256' as const,
  approxAccessLifetimeSec: 60 * 60,
  approxRefreshLifetimeSec: 30 * 24 * 60 * 60,
} as const;

export const OPENAI_API_BASE = 'https://api.openai.com';
export const CHATGPT_BACKEND_API = 'https://chatgpt.com/backend-api';
```

### Task 5.2: Implement `openaiOAuthService`

**Files:**
- Create: `apps/gateway/src/oauth/openai/openaiOAuthService.ts`

- [ ] **Step 1**: Implements `OAuthService` interface (Task 4.1):

```ts
export const openaiOAuthService: OAuthService = {
  platform: 'openai',
  
  async generateAuthURL(opts) {
    const verifier = generatePKCEVerifier();
    const challenge = generateCodeChallenge(verifier);
    const state = randomBytes(16).toString('base64url');
    const url = new URL(OPENAI_CODEX_OAUTH.authorizeEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', OPENAI_CODEX_OAUTH.clientId);
    url.searchParams.set('redirect_uri', opts.redirectURI ?? OPENAI_CODEX_OAUTH.defaultRedirectURI);
    url.searchParams.set('scope', OPENAI_CODEX_OAUTH.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', OPENAI_CODEX_OAUTH.pkceMethod);
    return { authUrl: url.toString(), state, codeVerifier: verifier };
  },

  async exchangeCode(opts) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_OAUTH.clientId,
      code: opts.code,
      redirect_uri: opts.redirectURI ?? OPENAI_CODEX_OAUTH.defaultRedirectURI,
      code_verifier: opts.codeVerifier,
    });
    const res = await fetch(OPENAI_CODEX_OAUTH.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new OAuthExchangeFailed(`http_${res.status}: ${await res.text()}`);
    const data = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      tokenType: data.token_type ?? 'Bearer',
    };
  },
};
```

### Task 5.3: Implement `openaiTokenRefresher`

**Files:**
- Create: `apps/gateway/src/oauth/openai/openaiTokenRefresher.ts`

- [ ] **Step 1**: Per design §6.5:

```ts
export const openaiTokenRefresher: TokenRefresher = {
  platform: 'openai',
  
  async refresh(refreshToken) {
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
      refreshToken: data.refresh_token ?? refreshToken,  // rotation per design A4
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      tokenType: data.token_type ?? 'Bearer',
    };
  },
};
```

### Task 5.4: Implement `openaiTokenProvider`

**Files:**
- Create: `apps/gateway/src/oauth/openai/openaiTokenProvider.ts`

- [ ] **Step 1**: Wraps `OAuthRefreshAPI.getValidAccessToken(accountId)` filtered to `platform === 'openai'`. Implements `TokenProvider` interface.

### Task 5.5: Localhost:1455 callback listener (decision A21)

**Files:**
- Create: `apps/gateway/src/oauth/callbackServer.ts`

- [ ] **Step 1**: Separate Fastify instance bound to `localhost:1455` only (not 0.0.0.0). Single route:

```ts
GET /auth/callback?code=...&state=...
```

- [ ] **Step 2**: Handler:
  - Look up flow state from Redis by `state`
  - Reject if not found / expired (15-min TTL)
  - Call `oauthRefreshAPI.exchangeAndStore(...)` (Task 5.6)
  - Respond with HTML page: "Authentication complete; you may close this window"

- [ ] **Step 3**: Started at gateway boot if `ENABLE_OPENAI_PROVIDER=true`; failure to bind logs warning + skips listener (admin uses fallback flow).

- [ ] **Step 4**: Graceful shutdown on gateway stop.

### Task 5.6: tRPC procedures `admin.oauth.{initiateFlow, callbackComplete, cancelFlow}`

**Files:**
- Create: `apps/api/src/trpc/routers/admin/oauth.ts`
- Modify: `apps/api/src/trpc/router.ts`

- [ ] **Step 1**:

```ts
export const oauthRouter = router({
  initiateFlow: adminProcedure
    .input(z.object({
      platform: z.enum(['anthropic', 'openai', 'gemini', 'antigravity']),
      groupId: z.string().uuid(),
      subscriptionTier: z.enum(['free', 'plus', 'pro', 'team', 'enterprise']).optional(),
      detectTier: z.boolean().default(false),  // if true, fetchPlanType after
      accountName: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertProviderEnabled(ctx, input.platform);
      const service = getOAuthService(ctx.oauthRegistry, input.platform);
      const { authUrl, state, codeVerifier } = await service.generateAuthURL({});
      const flowId = crypto.randomUUID();
      await ctx.redis.setex(`oauth:flow:${flowId}`, 15 * 60, JSON.stringify({
        flowId, state, codeVerifier, platform: input.platform, groupId: input.groupId,
        subscriptionTier: input.subscriptionTier, detectTier: input.detectTier,
        accountName: input.accountName, orgId: ctx.org.id, createdByUserId: ctx.user.id,
      }));
      // Index by state for callback lookup
      await ctx.redis.setex(`oauth:flow-by-state:${state}`, 15 * 60, flowId);
      return { flowId, authUrl, expiresInSec: 15 * 60 };
    }),

  callbackComplete: adminProcedure  // alternative to localhost:1455 listener (helper script)
    .input(z.object({ flowId: z.string(), code: z.string(), state: z.string() }))
    .mutation(async ({ ctx, input }) => { /* ... */ }),

  cancelFlow: adminProcedure
    .input(z.object({ flowId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Read flow state to delete state index too
      const stateRaw = await ctx.redis.get(`oauth:flow:${input.flowId}`);
      if (stateRaw) {
        const state = JSON.parse(stateRaw);
        await ctx.redis.del(`oauth:flow-by-state:${state.state}`);
      }
      await ctx.redis.del(`oauth:flow:${input.flowId}`);
      return { ok: true };
    }),

  pollFlow: adminProcedure
    .input(z.object({ flowId: z.string() }))
    .query(async ({ ctx, input }) => {
      const stateRaw = await ctx.redis.get(`oauth:flow:${input.flowId}`);
      if (!stateRaw) return { status: 'expired' as const };
      const state = JSON.parse(stateRaw);
      if (state.completedAccountId) {
        return { status: 'authorized' as const, accountId: state.completedAccountId, subscriptionTier: state.subscriptionTier };
      }
      if (state.error) return { status: 'failed' as const, error: state.error };
      return { status: 'pending' as const };
    }),
});
```

- [ ] **Step 2**: `assertProviderEnabled` checks `env.ENABLE_OPENAI_PROVIDER` for openai (and rejects gemini/antigravity in 5A as not-yet-implemented).

### Task 5.7: Account creation completion handler

**Files:**
- Create: `apps/gateway/src/oauth/openai/completeOAuthFlow.ts`

- [ ] **Step 1**: Called by callback listener (Task 5.5) AND by `admin.oauth.callbackComplete` (Task 5.6):

```ts
export async function completeOAuthFlow(opts: {
  flowId: string;
  code: string;
  state: string;
  deps: { db, redis, vault, oauthRegistry, masterKeyHex };
}) {
  // 1. Fetch + validate flow state
  const flowRaw = await opts.deps.redis.get(`oauth:flow:${opts.flowId}`);
  if (!flowRaw) throw new Error('flow_expired_or_invalid');
  const flow = JSON.parse(flowRaw);
  if (flow.state !== opts.state) throw new Error('state_mismatch');

  // 2. Exchange code for tokens
  const service = getOAuthService(opts.deps.oauthRegistry, flow.platform);
  const tokens = await service.exchangeCode({
    code: opts.code,
    codeVerifier: flow.codeVerifier,
  });

  // 3. Create upstream_account row
  const accountId = await opts.deps.db.transaction(async (tx) => {
    const [account] = await tx.insert(upstreamAccounts).values({
      orgId: flow.orgId,
      name: flow.accountName,
      platform: flow.platform,
      type: 'oauth',
      subscriptionTier: flow.subscriptionTier ?? null,
    }).returning();

    await opts.deps.vault.createTokens(account.id, tokens, opts.deps.masterKeyHex);

    await tx.insert(accountGroupMembers).values({
      accountId: account.id,
      groupId: flow.groupId,
    });

    return account.id;
  });

  // 4. Optional: fetchPlanType (Part 10)
  if (flow.detectTier && flow.platform === 'openai') {
    try {
      const planType = await fetchPlanType(tokens.accessToken);
      if (planType.planType) {
        await opts.deps.db.update(upstreamAccounts)
          .set({ subscriptionTier: planType.planType })
          .where(eq(upstreamAccounts.id, accountId));
      }
    } catch (err) { /* non-blocking; logged */ }
  }

  // 5. Probe with no-op call (decision A19 in earlier design — keep)
  await probeAccount(accountId, opts.deps);

  // 6. Mark flow complete
  await opts.deps.redis.setex(`oauth:flow:${opts.flowId}`, 60, JSON.stringify({
    ...flow, completedAccountId: accountId,
  }));

  return { accountId };
}
```

### Task 5.8: Probe-on-creation (no-op call)

**Files:**
- Create: `apps/gateway/src/oauth/openai/probeAccount.ts`

- [ ] **Step 1**: Call `/v1/responses` with `model: 'gpt-4o-mini', max_output_tokens: 1, input: 'ping'`. Expect 200; on 401/403 mark account `oauth_invalid` and roll back creation.

### Task 5.9: Tests for OpenAI OAuth

**Files:**
- Create: `apps/gateway/src/oauth/openai/openaiOAuthService.test.ts`
- Create: `apps/gateway/src/oauth/openai/openaiTokenRefresher.test.ts`
- Create: `apps/gateway/src/oauth/openai/completeOAuthFlow.test.ts`

- [ ] **Step 1**: Cover: generateAuthURL shape, exchangeCode happy + 4xx, refresh happy + rotation + invalid_grant, completeOAuthFlow end-to-end with mocked OpenAI HTTP.

---

## Part 6 — Body + stream translators (6 new directions)

**PR title:** `feat(plan-5a): translators for Anthropic ↔ OpenAI Responses + Chat ↔ Responses pivots`

**PR scope:** Pure functions in `packages/gateway-core/src/translate/`. No runtime wiring. Comprehensive tests + recorded SSE fixtures.

### Task 6.1: Stop-reason map

**Files:**
- Create: `packages/gateway-core/src/translate/stopReasonMap.ts`

- [ ] **Step 1**: Per design §10.4 — bidirectional functions for all three formats × 5 anthropic stop reasons.

- [ ] **Step 2**: Exhaustive unit tests.

### Task 6.2: Zod schemas for the three formats

**Files:**
- Create: `packages/gateway-core/src/translate/schemas.ts`

- [ ] **Step 1**: Define `AnthropicMessagesRequest` (likely already exists in 4A; consolidate), `ChatCompletionsRequest` (likely 4A), `ResponsesRequest` (NEW per design §9.4).

- [ ] **Step 2**: Schemas reused in route handlers (Part 9) and translators.

### Task 6.3: `translateAnthropicToResponses` body translator

**Files:**
- Create: `packages/gateway-core/src/translate/anthropicToResponses.ts`

- [ ] **Step 1**: Mapping per design §10.3:
  - `system` → `instructions`
  - `messages` → `input` (similar shape; transform content blocks)
  - `tools` → `tools` (anthropic name/input_schema → responses function/parameters)
  - `tool_choice` → `tool_choice` (anthropic 'any' → responses 'auto')
  - `max_tokens` → `max_output_tokens`
  - Drop `stop_sequences` with warning header
  - Drop `metadata`

- [ ] **Step 2**: Throw `BodyTranslationError` for unsupported features.

### Task 6.4: `translateResponsesToAnthropic` body translator

**Files:**
- Create: `packages/gateway-core/src/translate/responsesToAnthropic.ts`

- [ ] **Step 1**: Inverse of 6.3.

- [ ] **Step 2**: Reject Responses-specific features (`previous_response_id`, `store`, etc.) per design §9.4.

### Task 6.5: `translateChatToResponses` (pivot via Anthropic)

**Files:**
- Create: `packages/gateway-core/src/translate/chatToResponses.ts`

- [ ] **Step 1**: 1-line composition:

```ts
import { translateChatToAnthropic } from "./chatToAnthropic.js";
import { translateAnthropicToResponses } from "./anthropicToResponses.js";

export function translateChatToResponses(body: ChatRequest): ResponsesRequest {
  return translateAnthropicToResponses(translateChatToAnthropic(body));
}
```

### Task 6.6: `translateResponsesToChat` (pivot)

**Files:**
- Create: `packages/gateway-core/src/translate/responsesToChat.ts`

- [ ] **Step 1**: Inverse pivot.

### Task 6.7: Response (non-stream) translators

**Files:**
- Create: 6 response translator files mirroring request translators

- [ ] **Step 1**: For each request translator, paired response translator handles:
  - Choices/output array → content blocks
  - Stop reason mapping per Task 6.1
  - Usage block re-emission

### Task 6.8: Translator dispatch table

**Files:**
- Create: `packages/gateway-core/src/translate/dispatch.ts`

- [ ] **Step 1**: Per design §10.7 — three Records (request, response, stream) keyed by `${client}->${upstream}` with passthrough or function.

### Task 6.9: Stream translator interface + pipe wrapper

**Files:**
- Create: `packages/gateway-core/src/translate/stream/types.ts`
- Create: `packages/gateway-core/src/translate/stream/pipe.ts`

- [ ] **Step 1**: `StreamTranslator<U, C>` interface with `onEvent`, `onEnd`, `onError`.

- [ ] **Step 2**: `pipeStreamTranslator(upstream: ReadableStream, factory: StreamTranslatorFactory, parseUpstream, serializeClient): ReadableStream` per design §9.

- [ ] **Step 3**: SSE parser (`consumeSSEEvents`) handles CRLF/LF, multi-line data, comments.

### Task 6.10: 6 stream translators

**Files:**
- Create: `packages/gateway-core/src/translate/stream/anthropicStreamToChatStream.ts` (completes 4A Part 6.7 TODO)
- Create: `chatStreamToAnthropicStream.ts`
- Create: `anthropicStreamToResponsesStream.ts`
- Create: `responsesStreamToAnthropicStream.ts`
- Create: `chatStreamToResponsesStream.ts` (composition)
- Create: `responsesStreamToChatStream.ts` (composition)

- [ ] **Step 1**: Each is a state-machine `StreamTranslator`. State held: `~5 fields` per design §9.

- [ ] **Step 2**: Pivot translators (chat ↔ responses) compose two existing ones per design §10.6.

### Task 6.11: Snapshot tests + property tests

**Files:**
- Create: `packages/gateway-core/test/translate/stream/fixtures/anthropic/*.txt`
- Create: `packages/gateway-core/test/translate/stream/fixtures/chat/*.txt`
- Create: `packages/gateway-core/test/translate/stream/fixtures/responses/*.txt`
- Create: per-translator `*.test.ts`

- [ ] **Step 1**: Capture upstream SSE fixtures via real upstream calls (one-off; commit raw bytes). 10+ scenarios per format (text-only, tool-use, multi-block, error mid-stream, ping/heartbeat).

- [ ] **Step 2**: Tests load fixture, replay event-by-event through translator, assert client SSE matches expected.

- [ ] **Step 3**: Property tests with fast-check: random valid event sequences; assert never throws + always parseable output.

---

## Part 7 — 3-layer scheduler refactor

**PR title:** `feat(plan-5a): 3-layer account scheduler (replaces single-layer failoverLoop)`

**PR scope:** Replace `failoverLoop.ts` with new `scheduler.ts` implementing 3-layer pattern from sub2api. Existing 4A behaviour preserved (sticky session a no-op until clients send session metadata).

### Task 7.1: Scheduler interface + types

**Files:**
- Create: `apps/gateway/src/runtime/scheduler.ts`

- [ ] **Step 1**: Per design §8.1 — `ScheduleRequest`, `ScheduleDecision`, `AccountScheduler` interface.

### Task 7.2: Account runtime stats (EWMA)

**Files:**
- Create: `apps/gateway/src/runtime/runtimeStats.ts`

- [ ] **Step 1**: Per design §8.3 — Map-based EWMA tracking, alpha=0.2.

- [ ] **Step 2**: Tests for record/score, NaN initialization, decay over time.

### Task 7.3: Layer 1 — `previous_response_id` sticky

**Files:**
- Modify: `apps/gateway/src/runtime/scheduler.ts`

- [ ] **Step 1**: Redis key `sticky:resp:<groupId>:<previousResponseId>` → accountId. TTL 1 hour.

- [ ] **Step 2**: Lookup → validate account is in group, schedulable, model-compatible → return.

### Task 7.4: Layer 2 — `session_hash` sticky

**Files:**
- Modify: `apps/gateway/src/runtime/scheduler.ts`
- Create: `apps/gateway/src/runtime/sessionHash.ts`

- [ ] **Step 1**: Per design §8.5 — `generateSessionHash(parsedRequest)`:
  1. Highest priority: parse `metadata.user_id` for `_session_<uuid>` pattern (Claude Code)
  2. Mid: hash of `(system + messages)`
  3. Lowest: hash of `messages` only

- [ ] **Step 2**: Redis key `sticky:session:<groupId>:<sessionHash>` → accountId. TTL 30 min.

### Task 7.5: Layer 3 — load balance with EWMA

**Files:**
- Modify: `apps/gateway/src/runtime/scheduler.ts`

- [ ] **Step 1**: List all schedulable accounts in group (filter by group membership, status=active, schedulable=true, not in excludedSet).

- [ ] **Step 2**: Score each: `weighted_score = base_priority * (1 - errorRateEWMA) * 1/max(ttftEWMA, 100ms)`.

- [ ] **Step 3**: Pick top-K (default 3); weighted random among them. Log `loadSkew = (max - min) / mean`.

- [ ] **Step 4**: Acquire concurrency slot via existing `acquireSlot` helper (4A Redis ZSET). On full → return WaitPlan.

### Task 7.6: `runFailover` wrapper (replace 4A)

**Files:**
- Modify: `apps/gateway/src/runtime/failoverLoop.ts`

- [ ] **Step 1**: Per design §8.6 — thin wrapper over `scheduler.select()`. Handles error classification + excluded set.

- [ ] **Step 2**: All existing 4A `runFailover` callsites continue to work (signature compatible).

### Task 7.7: Scheduler metrics

**Files:**
- Modify: `apps/gateway/src/metrics.ts` (existing)

- [ ] **Step 1**: Register 6 new Prometheus metrics per design §8.7.

### Task 7.8: Scheduler tests

**Files:**
- Create: `apps/gateway/src/runtime/scheduler.test.ts`

- [ ] **Step 1**: Cases:
  - Layer 1 hit: previous_response_id valid → returns sticky account
  - Layer 1 miss → falls to Layer 2
  - Layer 2 hit: session_hash valid → returns sticky account
  - Layer 2 miss → falls to Layer 3
  - Layer 3: weighted random (run 1000 times, assert distribution within 20% of expected)
  - All accounts excluded → throws AllUpstreamsFailed
  - Account in different group → not selected
  - Slot acquire fails (group full) → returns WaitPlan
  - Cross-type within group: oauth + apikey both candidates (decision X7)
  - Failover excludes failed account on retry

---

## Part 8 — Group context middleware + autoRoute helper

**PR title:** `feat(plan-5a): group context middleware + autoRoute dispatch helper`

**PR scope:** Plumbing layer. Routes still default to anthropic until Part 9.

### Task 8.1: `resolveGroupContext` runtime function

**Files:**
- Create: `apps/gateway/src/runtime/groupDispatch.ts`

- [ ] **Step 1**: Per design §5.3:

```ts
export interface GroupContext {
  groupId: string;
  platform: Platform;
  rateMultiplier: number;
  isExclusive: boolean;
  isLegacy: boolean;  // synthetic group for legacy api keys without group_id
}

export async function resolveGroupContext(
  db: Db,
  apiKey: { id: string; orgId: string; groupId: string | null },
): Promise<GroupContext | null> {
  if (!apiKey.groupId) {
    // Legacy 4A behaviour
    return {
      groupId: `legacy:${apiKey.orgId}`,
      platform: 'anthropic',
      rateMultiplier: 1.0,
      isExclusive: false,
      isLegacy: true,
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
    platform: row.platform as Platform,
    rateMultiplier: Number(row.rateMultiplier),
    isExclusive: row.isExclusive,
    isLegacy: false,
  };
}
```

### Task 8.2: Group context middleware

**Files:**
- Create: `apps/gateway/src/middleware/groupContext.ts`

- [ ] **Step 1**: Fastify middleware that runs after `apiKeyAuthPlugin`:

```ts
export async function groupContextPlugin(app: FastifyInstance) {
  app.decorateRequest('gwGroupContext', null as GroupContext | null);
  app.addHook('preHandler', async (req) => {
    if (!req.apiKey) return;  // unauthenticated paths
    const ctx = await resolveGroupContext(app.db, req.apiKey);
    if (!ctx) {
      throw app.httpErrors.forbidden('group_not_found_or_disabled');
    }
    req.gwGroupContext = ctx;
  });
}
```

- [ ] **Step 2**: Register in gateway server bootstrap.

### Task 8.3: `autoRoute` helper

**Files:**
- Create: `apps/gateway/src/routes/dispatch.ts`

- [ ] **Step 1**: Per design §9.2:

```ts
type FastifyHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function autoRoute(
  byPlatform: Partial<Record<Platform, FastifyHandler>>,
  fallback?: FastifyHandler,
): FastifyHandler {
  return async (req, reply) => {
    const groupCtx = req.gwGroupContext;
    const platform = groupCtx?.platform ?? 'anthropic';
    const handler = byPlatform[platform] ?? fallback;
    if (!handler) {
      reply.code(404).send({ error: 'platform_not_supported_by_route' });
      return;
    }
    await handler(req, reply);
  };
}
```

### Task 8.4: `forcePlatform` helper (for Codex CLI alias path)

**Files:**
- Modify: `apps/gateway/src/routes/dispatch.ts`

- [ ] **Step 1**: For routes that ignore group platform (e.g., Codex CLI native URL):

```ts
export function forcePlatform(platform: Platform, handler: FastifyHandler): FastifyHandler {
  return async (req, reply) => {
    const groupCtx = req.gwGroupContext;
    if (!groupCtx) {
      reply.code(401).send({ error: 'group_required' });
      return;
    }
    if (groupCtx.platform !== platform) {
      reply.code(403).send({ error: `route_requires_platform_${platform}_but_group_is_${groupCtx.platform}` });
      return;
    }
    await handler(req, reply);
  };
}
```

Note: differs from sub2api's `ForcePlatform` middleware (which assigns the platform); we reject mismatch instead — safer.

### Task 8.5: Tests

**Files:**
- Create: `apps/gateway/src/runtime/groupDispatch.test.ts`
- Create: `apps/gateway/src/middleware/groupContext.test.ts`
- Create: `apps/gateway/src/routes/dispatch.test.ts`

- [ ] **Step 1**: Cases:
  - resolveGroupContext: valid group / disabled group / deleted group / legacy (null group_id)
  - Middleware: attaches ctx / throws forbidden / skips unauth requests
  - autoRoute: dispatches per platform / 404 on unknown / falls through to fallback
  - forcePlatform: rejects mismatched group / accepts matching group

---

## Part 9 — OpenAI route handlers + Codex CLI alias + chatCompletions streaming completion

**PR title:** `feat(plan-5a): /v1/responses + /v1/chat/completions streaming + Codex CLI alias`

**PR scope:** Activates the surface. Wires Parts 4-8 into route handlers. Activated by `ENABLE_OPENAI_PROVIDER=true`.

### Task 9.1: OpenAI handler — Messages (Anthropic-format input → OpenAI Responses upstream)

**Files:**
- Create: `apps/gateway/src/handlers/openai/messages.ts`

- [ ] **Step 1**: When `req.gwGroupContext.platform === 'openai'` AND request hits `/v1/messages`:
  1. Parse Anthropic format
  2. Resolve provider (group is openai; upstream format depends on account's preferred endpoint — Codex CLI accounts use `responses`; sk-key accounts can use either, default to `responses`)
  3. Translate body via `translateAnthropicToResponses`
  4. Schedule via `scheduler.select(...)`
  5. Acquire token via `oauthRefreshAPI.getValidAccessToken(account.id)` (oauth) or read sk-key (apikey)
  6. Call upstream
  7. Translate response/stream via `responsesStreamToAnthropicStream` (when streaming)
  8. Emit usage log

### Task 9.2: OpenAI handler — ChatCompletions

**Files:**
- Create: `apps/gateway/src/handlers/openai/chatCompletions.ts`

- [ ] **Step 1**: When group is openai AND route is `/v1/chat/completions`:
  - For sk-key accounts: passthrough to OpenAI Chat Completions endpoint
  - For oauth accounts: translate body to Responses, call Responses endpoint, translate back to Chat format

- [ ] **Step 2**: Streaming path uses appropriate translator chain.

### Task 9.3: OpenAI handler — Responses (new route)

**Files:**
- Create: `apps/gateway/src/handlers/openai/responses.ts`
- Create: `apps/gateway/src/routes/responses.ts`

- [ ] **Step 1**: Route handler at `POST /v1/responses`:
  - Zod schema per design §9.4 (text + function-calling subset only)
  - `rejectUnsupportedFeatures` for `previous_response_id`, `store`, etc.
  - When group platform = openai: passthrough to OpenAI Responses upstream
  - When group platform = anthropic: translate body via `translateResponsesToAnthropic`, call Anthropic, translate response/stream back
  - Streaming: appropriate translator

- [ ] **Step 2**: Subpath route `POST /v1/responses/*subpath` — same handler (sub2api pattern; some Codex CLI versions append subpath).

### Task 9.4: Codex CLI alias `/backend-api/codex/responses`

**Files:**
- Create: `apps/gateway/src/routes/codexResponses.ts`

- [ ] **Step 1**: Same handler as Task 9.3 but wrapped in `forcePlatform('openai', handler)` — Codex CLI's native URL always routes to OpenAI handler regardless of group platform.

- [ ] **Step 2**: Subpath variant.

- [ ] **Step 3**: Note: this URL path implies the api key MUST belong to an openai group; mismatched group → 403 with clear error.

### Task 9.5: Update `/v1/messages` route with autoRoute

**Files:**
- Modify: `apps/gateway/src/routes/messages.ts` (4A existing)

- [ ] **Step 1**: Wrap existing handler with autoRoute:

```ts
import { autoRoute } from "./dispatch.js";
import { handleAnthropicMessages } from "../handlers/anthropic/messages.js";  // existing 4A logic factored out
import { handleOpenAIMessages } from "../handlers/openai/messages.js";  // Task 9.1

export async function messagesRoutes(app: FastifyInstance) {
  app.post('/v1/messages', autoRoute({
    anthropic: handleAnthropicMessages,
    openai: handleOpenAIMessages,
  }));
}
```

- [ ] **Step 2**: Move existing 4A `routes/messages.ts` body into `handlers/anthropic/messages.ts` (extraction, not rewrite).

### Task 9.6: Update `/v1/chat/completions` route — streaming + autoRoute

**Files:**
- Modify: `apps/gateway/src/routes/chatCompletions.ts` (4A existing)

- [ ] **Step 1**: Remove the 501 streaming TODO (`Part 6.7`); wire `anthropicStreamToChatStream` for streaming when upstream is anthropic.

- [ ] **Step 2**: Wrap with autoRoute:

```ts
app.post('/v1/chat/completions', autoRoute({
  anthropic: handleAnthropicChatCompletions,  // existing 4A translate-to-anthropic-then-call path
  openai: handleOpenAIChatCompletions,  // Task 9.2
}));
```

### Task 9.7: Server bootstrap registration

**Files:**
- Modify: `apps/gateway/src/server.ts`

- [ ] **Step 1**: Register new routes:

```ts
await app.register(messagesRoutes);  // updated
await app.register(chatCompletionsRoutes);  // updated
await app.register(responsesRoutes);  // NEW Part 9 Task 9.3
await app.register(codexResponsesRoutes);  // NEW Part 9 Task 9.4
```

- [ ] **Step 2**: Boot OAuth callback listener if `env.ENABLE_OPENAI_PROVIDER`:

```ts
if (env.ENABLE_OPENAI_PROVIDER) {
  await startOAuthCallbackServer({ port: 1455, oauthRegistry, redis, db, vault });
}
```

- [ ] **Step 3**: Log enabled providers at startup.

---

## Part 10 — ImpersonateChrome + fetchPlanType + tier sync background job

**PR title:** `feat(plan-5a): ChatGPT subscription plan_type detection (ImpersonateChrome)`

**PR scope:** Subscription metadata fetch only; not on inference hot path. Decision A8 — start with npm `node-tls-fingerprint`; fall back to Go sidecar if needed.

### Task 10.1: ImpersonateChrome HTTP client

**Files:**
- Create: `apps/gateway/src/oauth/impersonate/client.ts`

- [ ] **Step 1**: Wrap chosen library (start with npm `node-tls-fingerprint` or `axios-cookiejar-support` + custom TLS context):

```ts
export interface ImpersonateClient {
  get(url: string, opts?: { headers?: Record<string, string> }): Promise<Response>;
}

export function createImpersonateChromeClient(): ImpersonateClient {
  // Implementation depends on library choice; start with npm option
  // Fallback to Go sidecar binary if npm option fails consistently in CI
}
```

- [ ] **Step 2**: Document the library choice in code comment + `docs/runbooks/impersonate-chrome-maintenance.md` (NEW).

### Task 10.2: `fetchPlanType` function

**Files:**
- Create: `apps/gateway/src/oauth/openai/fetchPlanType.ts`

- [ ] **Step 1**: Per design §12.3:

```ts
export interface PlanTypeResult {
  planType: 'free' | 'plus' | 'pro' | 'team' | 'enterprise' | null;
  raw: any;
}

export async function fetchPlanType(accessToken: string, deps: { client: ImpersonateClient }): Promise<PlanTypeResult> {
  try {
    const res = await deps.client.get(`${CHATGPT_BACKEND_API}/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { planType: null, raw: { http: res.status } };
    const data = await res.json();
    const tier = (data.plan_type ?? data.account_plan ?? null) as PlanTypeResult['planType'];
    return { planType: tier, raw: data };
  } catch (err) {
    return { planType: null, raw: { error: String(err) } };
  }
}
```

- [ ] **Step 2**: Tests with mocked client.

### Task 10.3: Wire into account creation

**Files:**
- Modify: `apps/gateway/src/oauth/openai/completeOAuthFlow.ts` (Part 5 Task 5.7)

- [ ] **Step 1**: Replace the placeholder TODO in step 4 with real fetchPlanType call:

```ts
if (flow.detectTier && flow.platform === 'openai') {
  const result = await fetchPlanType(tokens.accessToken, opts.deps);
  if (result.planType) {
    await opts.deps.db.update(upstreamAccounts)
      .set({ subscriptionTier: result.planType })
      .where(eq(upstreamAccounts.id, accountId));
  }
  // Always set "raw" into upstream_accounts.extra (or a separate column) for diagnostics
  await opts.deps.db.update(upstreamAccounts)
    .set({ /* extra column */: result.raw })
    .where(eq(upstreamAccounts.id, accountId));
}
```

### Task 10.4: Background tier sync job

**Files:**
- Create: `apps/gateway/src/oauth/openai/tierSyncJob.ts`

- [ ] **Step 1**: Daily cron — for each OpenAI OAuth account, fetch plan_type; update `subscription_tier` if changed.

- [ ] **Step 2**: Metrics: `gw_oauth_plan_type_fetch_success_total{platform,tier}`, `gw_oauth_plan_type_fetch_failed_total{platform}`.

- [ ] **Step 3**: Failures don't disable account; just leave tier stale.

### Task 10.5: Admin UI tier display + manual override

**Files:**
- Modify: `apps/web/src/components/admin/AccountDetail.tsx` (4A existing)

- [ ] **Step 1**: Show `subscription_tier` field with edit button. If null, show "tier unknown" + button "Detect tier" calling new `admin.oauth.detectTier({accountId})` mutation.

- [ ] **Step 2**: Manual override accepts dropdown of {free, plus, pro, team, enterprise, null}.

### Task 10.6: Tier hint table

**Files:**
- Create: `apps/web/src/data/openaiTierLimits.ts`

- [ ] **Step 1**: Per design §12.5:

```ts
export const OPENAI_TIER_LIMITS_INFORMATIONAL = {
  free: 'Limited access (gpt-4o-mini only)',
  plus: '~80 messages/3h on default model (approximate)',
  pro: '~unlimited GPT-4o, ~50 messages/week on o1 (approximate)',
  team: '~unlimited (subject to fair-use)',
  enterprise: 'Plan-specific (contact admin)',
} as const;
```

- [ ] **Step 2**: Render with prominent "(approximate, see OpenAI docs)" + link to openai.com/pricing.

---

## Part 11 — Admin UI (account groups + OAuth flow modal + cost dashboard breakdown)

**PR title:** `feat(plan-5a): admin UI — account groups + OAuth device-flow + per-platform cost breakdown`

**PR scope:** All user-visible admin surfaces. Final visible PR before E2E + docs.

### Task 11.1: tRPC `admin.accountGroups.*` procedures

**Files:**
- Create: `apps/api/src/trpc/routers/admin/accountGroups.ts`
- Modify: `apps/api/src/trpc/router.ts`

- [ ] **Step 1**: Procedures: `list`, `create`, `update`, `delete`, `addMember`, `removeMember`, `getById`.

- [ ] **Step 2**: RBAC per design §5.5.

- [ ] **Step 3**: `addMember` validates `account.platform === group.platform` server-side.

- [ ] **Step 4**: `delete` is soft (sets deleted_at); blocks if api_keys still reference the group.

### Task 11.2: AccountGroupsTable component

**Files:**
- Create: `apps/web/src/components/admin/AccountGroupsTable.tsx`
- Create: `apps/web/src/pages/admin/account-groups.tsx`

- [ ] **Step 1**: Table columns: name, platform, member count, rate_multiplier, status, actions.

- [ ] **Step 2**: Add Group dialog: name + platform (immutable after create) + description.

- [ ] **Step 3**: Edit Group dialog: rate_multiplier, isExclusive, status.

### Task 11.3: GroupDetail page (member management)

**Files:**
- Create: `apps/web/src/pages/admin/account-groups/[id].tsx`
- Create: `apps/web/src/components/admin/GroupMemberTable.tsx`

- [ ] **Step 1**: Detail page shows group fields + member account table.

- [ ] **Step 2**: "Add account to group" modal — list of accounts of matching platform NOT in this group; multi-select.

- [ ] **Step 3**: Inline priority edit per member (default 50).

- [ ] **Step 4**: Remove from group button (soft removes from join table).

### Task 11.4: AddAccountDialog flow extension (4-step wizard)

**Files:**
- Modify: `apps/web/src/components/admin/AddAccountDialog.tsx` (4A existing)

- [ ] **Step 1**: Step 1: Pick group (or create new). If new, set name + platform (immutable).

- [ ] **Step 2**: Step 2: Pick account type (OAuth subscription vs API key). Conditional on platform's available types.

- [ ] **Step 3**: Step 3 (OAuth): Choose detect-tier vs manual + tier dropdown. Step 3 (apikey): Paste key + Test button.

- [ ] **Step 4**: Step 4 (OAuth): Open OAuthDeviceFlowModal (Task 11.5). Step 4 (apikey): Save → vault row + account row + auto-add to group.

### Task 11.5: OAuthDeviceFlowModal component

**Files:**
- Create: `apps/web/src/components/admin/OAuthDeviceFlowModal.tsx`

- [ ] **Step 1**: On open, calls `admin.oauth.initiateFlow({platform, groupId, ...})` → receives `{flowId, authUrl}`.

- [ ] **Step 2**: Opens browser tab `window.open(authUrl)`. Shows in modal: "Complete login in browser; this dialog will update when done."

- [ ] **Step 3**: Polls `admin.oauth.pollFlow({flowId})` every 2s. On `authorized`: closes modal + refreshes account list. On `failed`: shows error. On `expired`: shows expiry message + retry button.

- [ ] **Step 4**: Cancel button → `admin.oauth.cancelFlow({flowId})` + close modal.

### Task 11.6: AccountsTable extensions

**Files:**
- Modify: `apps/web/src/components/admin/AccountsTable.tsx` (4A existing)

- [ ] **Step 1**: Per design §13.3 — add columns: Platform (with icon), Type (oauth/apikey badge), Tier (or "—"), Groups (comma-list), Status (with state icon).

- [ ] **Step 2**: Filter dropdown by platform.

- [ ] **Step 3**: Click row → AccountDetail page (already exists in 4A; extended in Task 10.5).

### Task 11.7: API key creation flow update

**Files:**
- Modify: `apps/web/src/components/admin/CreateApiKeyDialog.tsx` (4A existing)

- [ ] **Step 1**: New required field: Group dropdown (org's groups). Hidden for organizations with only legacy group.

- [ ] **Step 2**: Existing keys with `group_id = NULL` shown with "legacy" badge in `ApiKeysTable`.

- [ ] **Step 3**: Re-assign menu action moves an existing key to a different group.

### Task 11.8: Cost dashboard per-platform breakdown

**Files:**
- Modify: `apps/web/src/components/admin/CostSummaryCard.tsx` (4C Phase 1 component)

- [ ] **Step 1**: Per design §13.5 — group + platform breakdown using new `accountId/groupId/platform` columns from migration 0010.

- [ ] **Step 2**: Subscription rows show `$0.00 (subscription)` label.

- [ ] **Step 3**: Top models filtered by platform on click.

### Task 11.9: Subscription utilisation block (optional, depends on Part 10)

**Files:**
- Modify: `apps/web/src/components/admin/CostSummaryCard.tsx`

- [ ] **Step 1**: When `subscription_tier` is set, show informational hint from `openaiTierLimits.ts` (Task 10.6).

- [ ] **Step 2**: Note: 5A doesn't track real subscription usage; only shows tier hints. Real quota tracking deferred (per design §12.5).

### Task 11.10: Component tests

**Files:**
- Create: `apps/web/src/components/admin/AccountGroupsTable.test.tsx`
- Create: `apps/web/src/components/admin/OAuthDeviceFlowModal.test.tsx`
- Create: `apps/web/src/components/admin/AddAccountDialog.test.tsx`

- [ ] **Step 1**: Cover: render, mutations called with right args, polling, error states, empty states.

---

## Part 12 — E2E + smoke + docs

**PR title:** `feat(plan-5a): E2E suite + Codex CLI smoke + docs (UPGRADE-v0.6.0, runbooks)`

**PR scope:** Final integration tests, real-CLI smoke script, documentation. Last PR before tagging v0.6.0.

### Task 12.1: E2E `40-account-groups.spec.ts`

**Files:**
- Create: `apps/web/e2e/specs/40-account-groups.spec.ts`

- [ ] **Step 1**: Cases:
  - Admin creates an `openai-pool` group, platform=openai
  - Admin creates an OpenAI sk-key account, assigns to group
  - Admin creates an API key bound to the group
  - API key list shows the key with group badge

### Task 12.2: E2E `41-openai-oauth-flow.spec.ts`

**Files:**
- Create: `apps/web/e2e/specs/41-openai-oauth-flow.spec.ts`

- [ ] **Step 1**: Mock `auth.openai.com` endpoints via Playwright route:
  - `/oauth/authorize` returns redirect to localhost:1455 with code
  - `/oauth/token` returns synthetic tokens
  - `chatgpt.com/backend-api/me` returns `{plan_type: 'pro'}`

- [ ] **Step 2**: Walk 4-step wizard, assert account created, vault row encrypted, tier=pro set.

- [ ] **Step 3**: Cancel mid-flow → flow cleaned from Redis.

### Task 12.3: E2E `42-cross-format-streaming.spec.ts`

**Files:**
- Create: `apps/web/e2e/specs/42-cross-format-streaming.spec.ts`

- [ ] **Step 1**: Mock OpenAI Responses upstream + Anthropic Messages upstream.

- [ ] **Step 2**: Cases:
  - `/v1/messages` + openai group → stream translated; receives Anthropic SSE shape
  - `/v1/chat/completions` + anthropic group → stream translated (completes 4A Part 6.7); receives Chat SSE
  - `/v1/responses` + openai group → passthrough; receives Responses SSE

### Task 12.4: E2E `43-failover-cross-type.spec.ts`

**Files:**
- Create: `apps/web/e2e/specs/43-failover-cross-type.spec.ts`

- [ ] **Step 1**: Setup: openai group with one OAuth account (mocked 429) + one sk-key account (200 OK).

- [ ] **Step 2**: Issue request; assert succeeds via sk-key account; usage_logs shows account_id of sk-key.

### Task 12.5: Codex CLI smoke script

**Files:**
- Create: `scripts/smoke-codex-cli.sh`
- Create: `.github/workflows/codex-smoke.yml`

- [ ] **Step 1**: Shell script per earlier 5A impl design (test with mocked or real OpenAI key in CI secrets):

```bash
#!/usr/bin/env bash
set -euo pipefail
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3000}"
GATEWAY_API_KEY="${GATEWAY_API_KEY:?missing}"
which codex || npm i -g @openai/codex
OPENAI_BASE_URL="$GATEWAY_URL" \
OPENAI_API_KEY="$GATEWAY_API_KEY" \
codex --prompt "Write hello world in Python" --max-output-tokens 100 \
  > /tmp/codex-smoke-out.txt
[ -s /tmp/codex-smoke-out.txt ] || { echo "smoke_failed"; exit 1; }
echo "smoke_ok"
```

- [ ] **Step 2**: Workflow: weekly cron + on-demand. On failure: post to alert webhook + open GitHub issue.

### Task 12.6: `docs/UPGRADE-v0.6.0.md`

**Files:**
- Create: `docs/UPGRADE-v0.6.0.md`

- [ ] **Step 1**: Sections:
  - **Pre-upgrade**: tag v0.5.0 must be applied; backup database
  - **Migrations**: 0008/0009/0010 — what they do, rollback steps
  - **Group concept**: walkthrough creating a group + assigning accounts + binding API key
  - **OpenAI provider configuration**:
    - OAuth (ChatGPT subscription) flow
    - API key (sk-proj-...) flow
    - Subscription tier detection vs manual
  - **Codex CLI integration**: set `OPENAI_BASE_URL=<gateway>/v1` + `OPENAI_API_KEY=<gateway-key>`; or `OPENAI_BASE_URL=<gateway>/backend-api/codex` for native path
  - **Three URL spaces explanation**: `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, `/backend-api/codex/responses`
  - **Cross-format streaming behaviour matrix**
  - **Cost reporting changes**: OAuth shows `$0 (subscription)`; sk-key priced; rate_multiplier two-stage
  - **Pricing maintenance**: how to ship a new pricing migration
  - **Three-tier rollback plan**

### Task 12.7: Runbooks

**Files:**
- Create: `docs/runbooks/openai-oauth-vendor-update.md`
- Create: `docs/runbooks/openai-oauth-reauth.md`
- Create: `docs/runbooks/impersonate-chrome-maintenance.md`

- [ ] **Step 1**: Vendor update runbook: how to re-vendor `app_EMoamEEZ73f0CkXaXp7hrann` if Codex CLI changes.

- [ ] **Step 2**: Re-auth runbook: when account `oauth_invalid`, admin re-authorises via UI.

- [ ] **Step 3**: ImpersonateChrome maintenance: library choice rationale, when to switch to Go sidecar, what to do if Cloudflare blocks the npm lib.

### Task 12.8: CHANGELOG + README updates

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/EVALUATOR.md`

- [ ] **Step 1**: CHANGELOG entry under `## [Unreleased]` (becomes v0.6.0 on tag):

```markdown
### Added (Plan 5A — OpenAI provider)
- OpenAI as a peer upstream provider with Codex CLI OAuth flow + sk-key fallback
- `account_groups` concept — multi-account pools per platform; API keys bind to groups
- 3-layer scheduler (`previous_response_id` → `session_hash` → `load_balance`) replacing single-layer failover
- 4-piece OAuth pattern (`OAuthService + TokenProvider + TokenRefresher + RefreshPolicy`)
- Per-platform `RefreshPolicy` (Anthropic/OpenAI tolerant; Gemini/Antigravity strict — reserved for 5B/5C)
- `/v1/responses` route (Codex CLI native)
- `/backend-api/codex/responses` Codex CLI URL alias
- Six body translators + six stream translators across `(anthropic, chat, responses)`
- DB-backed `model_pricing` table replacing 4C constants
- `usage_logs` 4 token classes (input/output/cache_5m/cache_1h/cache_read/cached_input) + two-stage cost (total_cost vs actual_cost via group rate_multiplier)
- `subscription_tier` column on accounts + ImpersonateChrome plan_type detection
- Admin UI: account groups CRUD, OAuth device-flow modal, per-platform cost breakdown
- New env: `ENABLE_OPENAI_PROVIDER`
- New RBAC: `account_group.{list,create,update,delete,add_account,remove_account}`

### Migration
- 0008: account_groups + api_keys.group_id + subscription_tier
- 0009: model_pricing table + Anthropic/OpenAI seed
- 0010: llm_usage_events extension (4 token classes + actual_cost)

### Reference architecture
- Borrowed from sub2api (Wei-Shaw/sub2api): 4-platform model, group concept, 3-layer scheduler, 4-piece OAuth pattern, vendored Codex CLI client_id, RefreshPolicy matrix
```

- [ ] **Step 2**: README: add "Multi-provider support" section listing supported platforms (Anthropic since 4A; OpenAI added in 5A).

- [ ] **Step 3**: `docs/EVALUATOR.md`: extend "Multi-provider section" with OpenAI specifics.

---

## Acceptance criteria (5A)

The plan is complete when:

- [ ] All migrations apply + reverse cleanly (0008, 0009, 0010)
- [ ] All unit tests pass (`pnpm test`) — 200+ added
- [ ] All integration tests pass (`pnpm test:integration`) — 30+ added
- [ ] All E2E tests pass (`pnpm test:e2e`) — 4 new specs (40-43)
- [ ] Stream contract tests pass against weekly real-LLM run
- [ ] Codex CLI smoke green
- [ ] Coverage ≥ 85% in `@aide/gateway-core` translators; ≥ 80% in `apps/gateway/src/{oauth,runtime}/`
- [ ] Self-org soak: `ENABLE_OPENAI_PROVIDER=true` for 7 days; OAuth refresh succeeds; cross-format requests work
- [ ] First-token-latency p99 within +200ms of passthrough baseline
- [ ] No regression in 4A/4B/4C metrics
- [ ] `docs/UPGRADE-v0.6.0.md` complete
- [ ] CHANGELOG entry under `Unreleased` (becomes v0.6.0 on tag)
- [ ] All 12 PRs merged

After acceptance: tag `v0.6.0`, push Docker images, publish release notes, open Plan 5B (Gemini) handoff.

---

## Reference files

- `.claude/plans/2026-04-28-plan-5a-design.md` — design spec for 5A (1816 lines)
- `.claude/plans/2026-04-28-plan-5-handoff.md` — origin handoff (Plan 5 scope)
- `/tmp/aide-research/sub2api/` — reference architecture (read-only research clone)
- `apps/gateway/src/runtime/oauthRefresh.ts` (4A — anthropic-only; refactor in 5D)
- `apps/gateway/src/runtime/failoverLoop.ts` (replaced by `scheduler.ts`)
- `apps/gateway/src/runtime/upstreamCall.ts` (4A — extended with provider switch)
- `apps/gateway/src/runtime/usageLogging.ts` (4C — two-stage cost added)
- `apps/gateway/src/routes/messages.ts` (4A — wrapped with autoRoute)
- `apps/gateway/src/routes/chatCompletions.ts` (4A — streaming completed + autoRoute)
- `packages/gateway-core/src/translate/*.ts` (4A existing + 4 new body translators)
- `packages/gateway-core/src/translate/stream/*.ts` (NEW — 6 stream translators)
- `packages/db/src/schema/{accountGroups,apiKeys,accounts,llmUsageEvents,modelPricing}.ts`
- `packages/db/drizzle/0008_*.sql`, `0009_*.sql`, `0010_*.sql`
- `packages/evaluator/src/cost/{pricing,computeCost}.ts`
- `apps/api/src/trpc/routers/admin/{accountGroups,oauth}.ts`
- `apps/web/src/components/admin/{AccountGroupsTable,GroupMemberTable,OAuthDeviceFlowModal,AddAccountDialog,AccountsTable,CostSummaryCard}.tsx`
- `apps/web/e2e/specs/4{0,1,2,3}-*.spec.ts`
- `scripts/smoke-codex-cli.sh`
- `docs/UPGRADE-v0.6.0.md`, `docs/runbooks/{openai-oauth-vendor-update,openai-oauth-reauth,impersonate-chrome-maintenance}.md`




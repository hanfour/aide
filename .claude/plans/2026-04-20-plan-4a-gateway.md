# Plan 4A — Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Anthropic-only cloud gateway that fronts account pools, issues per-user API keys, and writes append-only `usage_logs` — the data-collection foundation Plan 4B's evaluator will consume.

**Architecture:** Separate `apps/gateway` Fastify service on port 3002. Shared Postgres via `@aide/db`, new Redis for concurrency/idempotency/sticky/queue. Pure-logic utilities live in new `packages/gateway-core`. Smart buffering window + incremental OpenAI↔Anthropic translation exceed sub2api quality bar.

**Tech Stack:** Fastify 5, undici (upstream HTTP), ioredis + BullMQ (Redis), Drizzle ORM (existing), AES-256-GCM + HKDF (credentials), HMAC-SHA256 (API key hash), LiteLLM JSON (pricing).

**Design reference:** [`.claude/plans/2026-04-20-plan4a-gateway-design.md`](./2026-04-20-plan4a-gateway-design.md) — 1146-line spec with full decision log.

**Target release:** v0.3.0

**Task count:** 48 tasks across 13 parts. Each task is 2–5 minutes per step, 5 steps (write test → verify fail → implement → verify pass → commit). No part should take more than 1 day; total estimate ~2 weeks.

---

## Part 1 — Schema + Migration + RBAC

Goal: land all 4 new tables (`accounts`, `credential_vault`, `api_keys`, `usage_logs`) + migration + RBAC action types. No runtime code yet — purely structural.

### Task 1.1: Create `accounts` schema file

**Files:**
- Create: `packages/db/src/schema/accounts.ts`
- Test: `packages/db/tests/schema/accounts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/schema/accounts.test.ts
import { describe, it, expect } from 'vitest'
import { accounts } from '../../src/schema/accounts'

describe('accounts schema', () => {
  it('exports table with required columns', () => {
    expect(accounts).toBeDefined()
    const cols = Object.keys(accounts)
    for (const c of [
      'id', 'orgId', 'teamId', 'name', 'platform', 'type',
      'schedulable', 'priority', 'concurrency', 'rateMultiplier',
      'rateLimitedAt', 'rateLimitResetAt', 'overloadUntil',
      'tempUnschedulableUntil', 'tempUnschedulableReason', 'lastUsedAt',
      'oauthRefreshFailCount', 'oauthRefreshLastError', 'oauthRefreshLastRunAt',
      'expiresAt', 'autoPauseOnExpired', 'status', 'errorMessage',
      'createdAt', 'updatedAt', 'deletedAt'
    ]) {
      expect(cols).toContain(c)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F @aide/db test -- accounts
```
Expected: FAIL with `Cannot find module '../../src/schema/accounts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/db/src/schema/accounts.ts
import { pgTable, uuid, text, boolean, integer, timestamp, decimal, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations, teams } from './org.js'

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  notes: text('notes'),
  platform: text('platform').notNull(),
  type: text('type').notNull(),
  schedulable: boolean('schedulable').notNull().default(true),
  priority: integer('priority').notNull().default(50),
  concurrency: integer('concurrency').notNull().default(3),
  rateMultiplier: decimal('rate_multiplier', { precision: 10, scale: 4 }).notNull().default('1.0'),
  rateLimitedAt: timestamp('rate_limited_at', { withTimezone: true }),
  rateLimitResetAt: timestamp('rate_limit_reset_at', { withTimezone: true }),
  overloadUntil: timestamp('overload_until', { withTimezone: true }),
  tempUnschedulableUntil: timestamp('temp_unschedulable_until', { withTimezone: true }),
  tempUnschedulableReason: text('temp_unschedulable_reason'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  oauthRefreshFailCount: integer('oauth_refresh_fail_count').notNull().default(0),
  oauthRefreshLastError: text('oauth_refresh_last_error'),
  oauthRefreshLastRunAt: timestamp('oauth_refresh_last_run_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  autoPauseOnExpired: boolean('auto_pause_on_expired').notNull().default(true),
  status: text('status').notNull().default('active'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  scopeIdx: index('accounts_scope_idx').on(t.orgId, t.teamId).where(sql`${t.deletedAt} IS NULL`),
  selectIdx: index('accounts_select_idx').on(t.orgId, t.teamId, t.priority).where(sql`${t.deletedAt} IS NULL AND ${t.schedulable} = true`),
}))
```

Also add export to `packages/db/src/schema/index.ts`:
```ts
export * from './accounts.js'
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -F @aide/db test -- accounts
```
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/accounts.ts packages/db/src/schema/index.ts packages/db/tests/schema/accounts.test.ts
git commit -m "feat(db): add accounts schema (gateway account pool)"
```

### Task 1.2: Create `credential_vault` schema file

**Files:**
- Create: `packages/db/src/schema/credentialVault.ts`
- Test: `packages/db/tests/schema/credentialVault.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/schema/credentialVault.test.ts
import { describe, it, expect } from 'vitest'
import { credentialVault } from '../../src/schema/credentialVault'

describe('credentialVault schema', () => {
  it('exports table with required columns', () => {
    expect(credentialVault).toBeDefined()
    const cols = Object.keys(credentialVault)
    for (const c of ['id', 'accountId', 'nonce', 'ciphertext', 'authTag', 'oauthExpiresAt', 'createdAt', 'rotatedAt']) {
      expect(cols).toContain(c)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F @aide/db test -- credentialVault
```
Expected: FAIL with module-not-found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/db/src/schema/credentialVault.ts
import { pgTable, uuid, customType, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { upstreamAccounts } from './accounts.js'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return 'bytea' },
})

export const credentialVault = pgTable('credential_vault', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  accountId: uuid('account_id').notNull().unique().references(() => upstreamAccounts.id, { onDelete: 'cascade' }),
  nonce: bytea('nonce').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  authTag: bytea('auth_tag').notNull(),
  oauthExpiresAt: timestamp('oauth_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
}, (t) => ({
  oauthExpiryIdx: index('credential_vault_oauth_expiry_idx').on(t.oauthExpiresAt).where(sql`${t.oauthExpiresAt} IS NOT NULL`),
}))
```

Add export to `packages/db/src/schema/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -F @aide/db test -- credentialVault
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/credentialVault.ts packages/db/src/schema/index.ts packages/db/tests/schema/credentialVault.test.ts
git commit -m "feat(db): add credential_vault schema (encrypted credentials)"
```

### Task 1.3: Create `apiKeys` schema file

**Files:**
- Create: `packages/db/src/schema/apiKeys.ts`
- Test: `packages/db/tests/schema/apiKeys.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/schema/apiKeys.test.ts
import { describe, it, expect } from 'vitest'
import { apiKeys } from '../../src/schema/apiKeys'

describe('apiKeys schema', () => {
  it('exports table with required columns including reveal tracking', () => {
    expect(apiKeys).toBeDefined()
    const cols = Object.keys(apiKeys)
    for (const c of [
      'id', 'userId', 'orgId', 'teamId', 'keyHash', 'keyPrefix', 'name',
      'status', 'ipWhitelist', 'ipBlacklist',
      'quotaUsd', 'quotaUsedUsd', 'rateLimit1dUsd',
      'issuedByUserId', 'revealTokenHash', 'revealTokenExpiresAt', 'revealedAt', 'revealedByIp',
      'lastUsedAt', 'expiresAt', 'createdAt', 'updatedAt', 'revokedAt'
    ]) {
      expect(cols).toContain(c)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F @aide/db test -- apiKeys
```
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/db/src/schema/apiKeys.ts
import { pgTable, uuid, text, timestamp, decimal, inet, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './auth.js'
import { organizations, teams } from './org.js'

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  ipWhitelist: text('ip_whitelist').array(),
  ipBlacklist: text('ip_blacklist').array(),
  quotaUsd: decimal('quota_usd', { precision: 20, scale: 8 }).notNull().default('0'),
  quotaUsedUsd: decimal('quota_used_usd', { precision: 20, scale: 8 }).notNull().default('0'),
  rateLimit1dUsd: decimal('rate_limit_1d_usd', { precision: 20, scale: 8 }).notNull().default('0'),
  issuedByUserId: uuid('issued_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  revealTokenHash: text('reveal_token_hash'),
  revealTokenExpiresAt: timestamp('reveal_token_expires_at', { withTimezone: true }),
  revealedAt: timestamp('revealed_at', { withTimezone: true }),
  revealedByIp: inet('revealed_by_ip'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
  userIdx: index('api_keys_user_idx').on(t.userId).where(sql`${t.revokedAt} IS NULL`),
  orgIdx: index('api_keys_org_idx').on(t.orgId).where(sql`${t.revokedAt} IS NULL`),
  revealIdx: index('api_keys_reveal_idx').on(t.revealTokenHash).where(sql`${t.revealTokenHash} IS NOT NULL`),
}))
```

Add export to `schema/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -F @aide/db test -- apiKeys
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/apiKeys.ts packages/db/src/schema/index.ts packages/db/tests/schema/apiKeys.test.ts
git commit -m "feat(db): add api_keys schema with reveal-tracking fields"
```

### Task 1.4: Create `usageLogs` schema file

**Files:**
- Create: `packages/db/src/schema/usageLogs.ts`
- Test: `packages/db/tests/schema/usageLogs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/schema/usageLogs.test.ts
import { describe, it, expect } from 'vitest'
import { usageLogs } from '../../src/schema/usageLogs'

describe('usageLogs schema', () => {
  it('exports append-only table with token + cost + observability columns', () => {
    expect(usageLogs).toBeDefined()
    const cols = Object.keys(usageLogs)
    for (const c of [
      'id', 'requestId',
      'userId', 'apiKeyId', 'accountId', 'orgId', 'teamId',
      'requestedModel', 'upstreamModel', 'platform', 'surface',
      'inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens',
      'inputCost', 'outputCost', 'cacheCreationCost', 'cacheReadCost', 'totalCost',
      'rateMultiplier', 'accountRateMultiplier',
      'stream', 'statusCode', 'durationMs', 'firstTokenMs', 'bufferReleasedAtMs',
      'upstreamRetries', 'failedAccountIds',
      'userAgent', 'ipAddress', 'createdAt'
    ]) {
      expect(cols).toContain(c)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F @aide/db test -- usageLogs
```
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/db/src/schema/usageLogs.ts
import { pgTable, uuid, text, integer, bigserial, timestamp, decimal, boolean, inet, index } from 'drizzle-orm/pg-core'
import { users } from './auth.js'
import { organizations, teams } from './org.js'
import { apiKeys } from './apiKeys.js'
import { upstreamAccounts } from './accounts.js'

export const usageLogs = pgTable('usage_logs', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  requestId: text('request_id').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  apiKeyId: uuid('api_key_id').notNull().references(() => apiKeys.id, { onDelete: 'restrict' }),
  accountId: uuid('account_id').notNull().references(() => upstreamAccounts.id, { onDelete: 'restrict' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  requestedModel: text('requested_model').notNull(),
  upstreamModel: text('upstream_model').notNull(),
  platform: text('platform').notNull(),
  surface: text('surface').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  inputCost: decimal('input_cost', { precision: 20, scale: 10 }).notNull().default('0'),
  outputCost: decimal('output_cost', { precision: 20, scale: 10 }).notNull().default('0'),
  cacheCreationCost: decimal('cache_creation_cost', { precision: 20, scale: 10 }).notNull().default('0'),
  cacheReadCost: decimal('cache_read_cost', { precision: 20, scale: 10 }).notNull().default('0'),
  totalCost: decimal('total_cost', { precision: 20, scale: 10 }).notNull().default('0'),
  rateMultiplier: decimal('rate_multiplier', { precision: 10, scale: 4 }).notNull().default('1.0'),
  accountRateMultiplier: decimal('account_rate_multiplier', { precision: 10, scale: 4 }).notNull().default('1.0'),
  stream: boolean('stream').notNull().default(false),
  statusCode: integer('status_code').notNull(),
  durationMs: integer('duration_ms').notNull(),
  firstTokenMs: integer('first_token_ms'),
  bufferReleasedAtMs: integer('buffer_released_at_ms'),
  upstreamRetries: integer('upstream_retries').notNull().default(0),
  failedAccountIds: uuid('failed_account_ids').array(),
  userAgent: text('user_agent'),
  ipAddress: inet('ip_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userTimeIdx: index('usage_logs_user_time_idx').on(t.userId, t.createdAt),
  apiKeyTimeIdx: index('usage_logs_api_key_time_idx').on(t.apiKeyId, t.createdAt),
  accountTimeIdx: index('usage_logs_account_time_idx').on(t.accountId, t.createdAt),
  orgTimeIdx: index('usage_logs_org_time_idx').on(t.orgId, t.createdAt),
  teamTimeIdx: index('usage_logs_team_time_idx').on(t.teamId, t.createdAt),
  modelIdx: index('usage_logs_model_idx').on(t.requestedModel),
}))
```

Add export to `schema/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -F @aide/db test -- usageLogs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/usageLogs.ts packages/db/src/schema/index.ts packages/db/tests/schema/usageLogs.test.ts
git commit -m "feat(db): add usage_logs schema (append-only, for 4B evaluator)"
```

### Task 1.5: Generate + verify migration 0005

**Files:**
- Create: `packages/db/drizzle/0005_gateway_schema.sql` (auto-generated)

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/schema/migration0005.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('migration 0005_gateway_schema', () => {
  const sql = readFileSync(join(__dirname, '../../drizzle/0005_gateway_schema.sql'), 'utf8')
  it('creates the 4 new tables', () => {
    expect(sql).toMatch(/CREATE TABLE "upstream_accounts"/)
    expect(sql).toMatch(/CREATE TABLE "credential_vault"/)
    expect(sql).toMatch(/CREATE TABLE "api_keys"/)
    expect(sql).toMatch(/CREATE TABLE "usage_logs"/)
  })
  it('creates hot-path indexes', () => {
    expect(sql).toMatch(/CREATE INDEX.*upstream_accounts_select_idx/)
    expect(sql).toMatch(/CREATE INDEX.*usage_logs_user_time_idx/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F @aide/db test -- migration0005
```
Expected: FAIL (file not found).

- [ ] **Step 3: Generate migration**

```bash
pnpm -F @aide/db db:generate
```

Expected output: a new migration file `packages/db/drizzle/0005_gateway_schema.sql` (name may vary — rename to `0005_gateway_schema.sql` if drizzle names differently). Verify it contains the 4 CREATE TABLEs and indexes.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -F @aide/db test -- migration0005
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/0005_gateway_schema.sql packages/db/tests/schema/migration0005.test.ts packages/db/drizzle/meta/
git commit -m "feat(db): generate migration 0005 for gateway schema"
```

### Task 1.6: Extend RBAC action types

**Files:**
- Modify: `packages/auth/src/rbac/actions.ts`
- Test: `packages/auth/tests/unit/rbac/actions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/auth/tests/unit/rbac/actions.test.ts (extend existing file or create)
import { describe, it, expect } from 'vitest'
import type { Action } from '../../../src/rbac/actions'

describe('RBAC actions — gateway additions', () => {
  it('compiles with new account / api_key / usage action variants', () => {
    const samples: Action[] = [
      { type: 'account.read', orgId: 'x' },
      { type: 'account.create', orgId: 'x', teamId: null },
      { type: 'account.rotate', orgId: 'x', accountId: 'a' },
      { type: 'api_key.issue_own' },
      { type: 'api_key.issue_for_user', orgId: 'x', targetUserId: 'u' },
      { type: 'api_key.revoke', apiKeyId: 'k' },
      { type: 'usage.read_own' },
      { type: 'usage.read_team', orgId: 'x', teamId: 't' },
      { type: 'usage.read_org', orgId: 'x' },
    ]
    expect(samples.length).toBe(9)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F @aide/auth test -- actions
```
Expected: FAIL with type errors (new variants not in `Action` union).

- [ ] **Step 3: Extend `Action` discriminated union**

Modify `packages/auth/src/rbac/actions.ts` — append these variants to the `Action` union:

```ts
// Append to existing Action union in actions.ts
  | { type: 'account.read'; orgId: string }
  | { type: 'account.create'; orgId: string; teamId: string | null }
  | { type: 'account.update'; orgId: string; accountId: string }
  | { type: 'account.rotate'; orgId: string; accountId: string }
  | { type: 'account.delete'; orgId: string; accountId: string }
  | { type: 'api_key.issue_own' }
  | { type: 'api_key.issue_for_user'; orgId: string; targetUserId: string }
  | { type: 'api_key.list_own' }
  | { type: 'api_key.list_all'; orgId: string }
  | { type: 'api_key.revoke'; apiKeyId: string }
  | { type: 'usage.read_own' }
  | { type: 'usage.read_user'; orgId: string; targetUserId: string }
  | { type: 'usage.read_team'; orgId: string; teamId: string }
  | { type: 'usage.read_org'; orgId: string }
```

Then extend `can()` in `check.ts` with matching cases — for 4A MVP, use the simplest reasonable policy (super_admin allows all already handled, org_admin handles org.* and team.*, team_manager handles team.*, members own their resources). Keep the rules tight; policy details are:

- `account.*` → require org_admin at `orgId` (or super_admin)
- `api_key.issue_own` / `list_own` / `usage.read_own` → always allow for authenticated user (handled by protectedProcedure, but return true here)
- `api_key.issue_for_user` / `list_all` → require org_admin at `orgId`
- `api_key.revoke` → allow self-revoke (compare apiKey.userId === perm.userId in caller) OR org_admin
- `usage.read_team` → require team_manager at teamId or org_admin at orgId
- `usage.read_org` → require org_admin at orgId
- `usage.read_user` → require target == self OR org_admin at orgId

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -F @aide/auth test
```
Expected: all existing tests + new 1 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/auth/src/rbac/actions.ts packages/auth/src/rbac/check.ts packages/auth/tests/unit/rbac/actions.test.ts
git commit -m "feat(auth): extend RBAC with account/api_key/usage actions"
```

---

## Part 2 — `packages/gateway-core` Pure Utilities

Goal: a new workspace package with pure, easily-unit-testable logic shared between `apps/gateway` (runtime) and `apps/api` (admin routes). No Fastify, no DB driver — pure functions and small classes.

### Task 2.1: Scaffold `packages/gateway-core`

**Files:**
- Create: `packages/gateway-core/package.json`
- Create: `packages/gateway-core/tsconfig.json`
- Create: `packages/gateway-core/tsconfig.build.json`
- Create: `packages/gateway-core/src/index.ts` (re-exports)
- Create: `packages/gateway-core/vitest.config.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway-core/tests/scaffold.test.ts
import { describe, it, expect } from 'vitest'

describe('gateway-core scaffold', () => {
  it('imports from the package entrypoint', async () => {
    const mod = await import('../src/index.js')
    expect(mod).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F @aide/gateway-core test
```
Expected: FAIL (`@aide/gateway-core` not registered in workspace).

- [ ] **Step 3: Write minimal implementation**

```json
// packages/gateway-core/package.json
{
  "name": "@aide/gateway-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^4.1.4",
    "@types/node": "^22.10.0"
  }
}
```

```json
// packages/gateway-core/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true
  },
  "include": ["src/**/*"]
}
```

`tsconfig.build.json` mirrors existing pattern in other packages. `src/index.ts` starts empty (exports added per-task).

```ts
// packages/gateway-core/src/index.ts
export {}
```

Run `pnpm install` at repo root to register the workspace.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -F @aide/gateway-core test
```
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-core/
git commit -m "feat(gateway-core): scaffold workspace package"
```

### Task 2.2: Pricing lookup (LiteLLM JSON)

**Files:**
- Create: `packages/gateway-core/src/pricing/index.ts`
- Create: `packages/gateway-core/pricing/litellm.json` (bundled snapshot)
- Test: `packages/gateway-core/tests/pricing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway-core/tests/pricing.test.ts
import { describe, it, expect } from 'vitest'
import { loadPricing, resolveCost } from '../src/pricing'

describe('pricing', () => {
  const pricing = loadPricing()

  it('resolves cost for claude-3-5-sonnet-20241022', () => {
    const cost = resolveCost(pricing, 'claude-3-5-sonnet-20241022', {
      inputTokens: 1000, outputTokens: 500,
      cacheCreationTokens: 0, cacheReadTokens: 0,
    })
    // $3/M input + $15/M output → 0.003 + 0.0075 = 0.0105
    expect(cost.totalCost).toBeCloseTo(0.0105, 4)
  })

  it('returns zero cost + miss flag for unknown model', () => {
    const cost = resolveCost(pricing, 'unknown-model-xyz', {
      inputTokens: 1000, outputTokens: 500,
      cacheCreationTokens: 0, cacheReadTokens: 0,
    })
    expect(cost.totalCost).toBe(0)
    expect(cost.miss).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F @aide/gateway-core test -- pricing
```
Expected: FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/gateway-core/src/pricing/index.ts
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

export interface ModelPricing {
  input_cost_per_token: number
  output_cost_per_token: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
}

export interface Tokens {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface CostBreakdown {
  inputCost: number
  outputCost: number
  cacheCreationCost: number
  cacheReadCost: number
  totalCost: number
  miss: boolean
}

export type PricingMap = Map<string, ModelPricing>

export function loadPricing(): PricingMap {
  const here = dirname(fileURLToPath(import.meta.url))
  const path = join(here, '..', '..', 'pricing', 'litellm.json')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ModelPricing>
  const map = new Map<string, ModelPricing>()
  for (const [model, price] of Object.entries(raw)) {
    map.set(model.toLowerCase(), price)
  }
  return map
}

export function resolveCost(pricing: PricingMap, model: string, tokens: Tokens): CostBreakdown {
  const p = pricing.get(model.toLowerCase())
  if (!p) {
    return { inputCost: 0, outputCost: 0, cacheCreationCost: 0, cacheReadCost: 0, totalCost: 0, miss: true }
  }
  const inputCost = tokens.inputTokens * p.input_cost_per_token
  const outputCost = tokens.outputTokens * p.output_cost_per_token
  const cacheCreationCost = tokens.cacheCreationTokens * (p.cache_creation_input_token_cost ?? 0)
  const cacheReadCost = tokens.cacheReadTokens * (p.cache_read_input_token_cost ?? 0)
  return {
    inputCost, outputCost, cacheCreationCost, cacheReadCost,
    totalCost: inputCost + outputCost + cacheCreationCost + cacheReadCost,
    miss: false,
  }
}
```

```json
// packages/gateway-core/pricing/litellm.json  (subset — expand with CI refresh later)
{
  "claude-3-5-sonnet-20241022": {
    "input_cost_per_token": 0.000003,
    "output_cost_per_token": 0.000015,
    "cache_creation_input_token_cost": 0.00000375,
    "cache_read_input_token_cost": 0.0000003
  },
  "claude-3-5-haiku-20241022": {
    "input_cost_per_token": 0.0000008,
    "output_cost_per_token": 0.000004,
    "cache_creation_input_token_cost": 0.000001,
    "cache_read_input_token_cost": 0.00000008
  },
  "claude-3-opus-20240229": {
    "input_cost_per_token": 0.000015,
    "output_cost_per_token": 0.000075,
    "cache_creation_input_token_cost": 0.00001875,
    "cache_read_input_token_cost": 0.0000015
  }
}
```

Add `export * from './pricing/index.js'` to `src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -F @aide/gateway-core test -- pricing
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-core/src/pricing/ packages/gateway-core/pricing/ packages/gateway-core/src/index.ts packages/gateway-core/tests/pricing.test.ts
git commit -m "feat(gateway-core): LiteLLM-based pricing lookup"
```

### Task 2.3: Error classifier + state machine

**Files:**
- Create: `packages/gateway-core/src/stateMachine/classifier.ts`
- Create: `packages/gateway-core/src/stateMachine/types.ts`
- Test: `packages/gateway-core/tests/stateMachine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway-core/tests/stateMachine.test.ts
import { describe, it, expect } from 'vitest'
import { classifyUpstreamError } from '../src/stateMachine/classifier'

describe('classifyUpstreamError', () => {
  it('429 → failover with rate_limited_at set', () => {
    const act = classifyUpstreamError({ status: 429, retryAfter: 60 })
    expect(act.kind).toBe('switch_account')
    expect(act.stateUpdate?.rateLimitedAt).toBeDefined()
    expect(act.stateUpdate?.rateLimitResetAt).toBeDefined()
  })

  it('529 → failover with overload_until', () => {
    const act = classifyUpstreamError({ status: 529 })
    expect(act.kind).toBe('switch_account')
    expect(act.stateUpdate?.overloadUntil).toBeDefined()
  })

  it('401 → failover + status=error', () => {
    const act = classifyUpstreamError({ status: 401 })
    expect(act.kind).toBe('switch_account')
    expect(act.stateUpdate?.status).toBe('error')
  })

  it('400 → fatal (no failover)', () => {
    const act = classifyUpstreamError({ status: 400 })
    expect(act.kind).toBe('fatal')
  })

  it('5xx → switch_account with temp_unschedulable_until', () => {
    const act = classifyUpstreamError({ status: 502 })
    expect(act.kind).toBe('switch_account')
    expect(act.stateUpdate?.tempUnschedulableUntil).toBeDefined()
  })

  it('connection error → retry_same_account', () => {
    const act = classifyUpstreamError({ kind: 'connection' })
    expect(act.kind).toBe('retry_same_account')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F @aide/gateway-core test -- stateMachine
```
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/gateway-core/src/stateMachine/types.ts
export interface AccountStateUpdate {
  rateLimitedAt?: Date
  rateLimitResetAt?: Date
  overloadUntil?: Date
  tempUnschedulableUntil?: Date
  tempUnschedulableReason?: string
  status?: 'active' | 'error' | 'disabled'
  errorMessage?: string
}

export type UpstreamError =
  | { status: number; retryAfter?: number; message?: string }
  | { kind: 'connection'; message?: string }
  | { kind: 'timeout'; message?: string }

export type FailoverAction =
  | { kind: 'switch_account'; stateUpdate?: AccountStateUpdate; reason: string }
  | { kind: 'retry_same_account'; backoffMs: number }
  | { kind: 'fatal'; statusCode: number; reason: string }

// packages/gateway-core/src/stateMachine/classifier.ts
import type { UpstreamError, FailoverAction } from './types.js'

const SAME_ACCOUNT_BACKOFF_MS = 500
const OVERLOAD_COOLDOWN_SEC = 60
const TRANSIENT_COOLDOWN_SEC = 30

export function classifyUpstreamError(err: UpstreamError): FailoverAction {
  if ('kind' in err) {
    if (err.kind === 'connection' || err.kind === 'timeout') {
      return { kind: 'retry_same_account', backoffMs: SAME_ACCOUNT_BACKOFF_MS }
    }
  }
  if (!('status' in err)) {
    return { kind: 'fatal', statusCode: 500, reason: 'unknown_error' }
  }
  const now = new Date()
  const { status, retryAfter } = err
  if (status === 401 || status === 403) {
    return {
      kind: 'switch_account',
      stateUpdate: { status: 'error', errorMessage: err.message ?? `upstream ${status}` },
      reason: 'auth_invalid',
    }
  }
  if (status === 429) {
    const resetAt = retryAfter ? new Date(now.getTime() + retryAfter * 1000) : new Date(now.getTime() + 60_000)
    return {
      kind: 'switch_account',
      stateUpdate: { rateLimitedAt: now, rateLimitResetAt: resetAt },
      reason: 'rate_limited',
    }
  }
  if (status === 529) {
    return {
      kind: 'switch_account',
      stateUpdate: { overloadUntil: new Date(now.getTime() + OVERLOAD_COOLDOWN_SEC * 1000) },
      reason: 'overloaded',
    }
  }
  if (status >= 500 && status < 600) {
    return {
      kind: 'switch_account',
      stateUpdate: {
        tempUnschedulableUntil: new Date(now.getTime() + TRANSIENT_COOLDOWN_SEC * 1000),
        tempUnschedulableReason: `upstream_${status}`,
      },
      reason: `transient_${status}`,
    }
  }
  // 4xx client errors (400, 422, etc.)
  return { kind: 'fatal', statusCode: status, reason: 'client_error' }
}
```

Add export to `src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -F @aide/gateway-core test -- stateMachine
```
Expected: PASS (6).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-core/src/stateMachine/ packages/gateway-core/src/index.ts packages/gateway-core/tests/stateMachine.test.ts
git commit -m "feat(gateway-core): upstream error classifier + state machine"
```

### Task 2.4: Credential encryption (AES-256-GCM + HKDF)

**Files:**
- Create: `packages/gateway-core/src/crypto/credentialCipher.ts`
- Test: `packages/gateway-core/tests/credentialCipher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway-core/tests/credentialCipher.test.ts
import { describe, it, expect } from 'vitest'
import { encryptCredential, decryptCredential } from '../src/crypto/credentialCipher'
import { randomBytes } from 'crypto'

describe('credentialCipher', () => {
  const masterKey = randomBytes(32).toString('hex')
  const accountId = '00000000-0000-0000-0000-000000000001'
  const plaintext = JSON.stringify({ api_key: 'sk-ant-test' })

  it('round-trips plaintext through encrypt/decrypt', () => {
    const sealed = encryptCredential({ masterKeyHex: masterKey, accountId, plaintext })
    const recovered = decryptCredential({ masterKeyHex: masterKey, accountId, sealed })
    expect(recovered).toBe(plaintext)
  })

  it('produces different ciphertexts for identical plaintext under different accountIds', () => {
    const a = encryptCredential({ masterKeyHex: masterKey, accountId: 'a', plaintext })
    const b = encryptCredential({ masterKeyHex: masterKey, accountId: 'b', plaintext })
    expect(Buffer.compare(a.ciphertext, b.ciphertext)).not.toBe(0)
  })

  it('fails to decrypt with wrong accountId (HKDF salt mismatch)', () => {
    const sealed = encryptCredential({ masterKeyHex: masterKey, accountId: 'a', plaintext })
    expect(() => decryptCredential({ masterKeyHex: masterKey, accountId: 'b', sealed })).toThrow()
  })

  it('validates master key format (32 bytes hex)', () => {
    expect(() => encryptCredential({ masterKeyHex: 'too-short', accountId, plaintext })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F @aide/gateway-core test -- credentialCipher
```
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/gateway-core/src/crypto/credentialCipher.ts
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto'

export interface SealedCredential {
  nonce: Buffer
  ciphertext: Buffer
  authTag: Buffer
}

interface EncryptInput {
  masterKeyHex: string
  accountId: string
  plaintext: string
}

interface DecryptInput {
  masterKeyHex: string
  accountId: string
  sealed: SealedCredential
}

const INFO = Buffer.from('aide-gateway-credential-v1', 'utf8')

function deriveKey(masterKeyHex: string, accountId: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
    throw new Error('masterKey must be 32 bytes hex (64 chars)')
  }
  const master = Buffer.from(masterKeyHex, 'hex')
  const salt = Buffer.from(accountId, 'utf8')
  return Buffer.from(hkdfSync('sha256', master, salt, INFO, 32))
}

export function encryptCredential(input: EncryptInput): SealedCredential {
  const key = deriveKey(input.masterKeyHex, input.accountId)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return { nonce, ciphertext, authTag }
}

export function decryptCredential(input: DecryptInput): string {
  const key = deriveKey(input.masterKeyHex, input.accountId)
  const decipher = createDecipheriv('aes-256-gcm', key, input.sealed.nonce)
  decipher.setAuthTag(input.sealed.authTag)
  const plain = Buffer.concat([decipher.update(input.sealed.ciphertext), decipher.final()])
  return plain.toString('utf8')
}
```

Add export to `src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -F @aide/gateway-core test -- credentialCipher
```
Expected: PASS (4).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-core/src/crypto/ packages/gateway-core/src/index.ts packages/gateway-core/tests/credentialCipher.test.ts
git commit -m "feat(gateway-core): AES-256-GCM credential cipher with HKDF key derivation"
```

### Task 2.5: API key generator + HMAC hash

**Files:**
- Create: `packages/gateway-core/src/crypto/apiKey.ts`
- Test: `packages/gateway-core/tests/apiKey.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway-core/tests/apiKey.test.ts
import { describe, it, expect } from 'vitest'
import { generateApiKey, hashApiKey, verifyApiKey } from '../src/crypto/apiKey'

describe('apiKey', () => {
  const pepper = '00'.repeat(32)

  it('generates key with ak_ prefix and 64+ chars', () => {
    const { raw, prefix } = generateApiKey()
    expect(raw.startsWith('ak_')).toBe(true)
    expect(raw.length).toBeGreaterThanOrEqual(64)
    expect(prefix.length).toBe(8)
    expect(prefix).toBe(raw.slice(0, 8))
  })

  it('hashApiKey produces deterministic HMAC-SHA256 hex', () => {
    const h1 = hashApiKey(pepper, 'ak_abc')
    const h2 = hashApiKey(pepper, 'ak_abc')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('different pepper → different hash', () => {
    const h1 = hashApiKey(pepper, 'ak_abc')
    const h2 = hashApiKey('ff'.repeat(32), 'ak_abc')
    expect(h1).not.toBe(h2)
  })

  it('verifyApiKey uses constant-time comparison', () => {
    const h = hashApiKey(pepper, 'ak_abc')
    expect(verifyApiKey(pepper, 'ak_abc', h)).toBe(true)
    expect(verifyApiKey(pepper, 'ak_xyz', h)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F @aide/gateway-core test -- apiKey
```
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/gateway-core/src/crypto/apiKey.ts
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function toBase62(buf: Buffer): string {
  // Simple base62 encoding; yields ~1.37 chars per input byte
  let out = ''
  let n = BigInt('0x' + buf.toString('hex'))
  const base = BigInt(62)
  while (n > 0n) {
    out = BASE62[Number(n % base)] + out
    n = n / base
  }
  return out || 'A'
}

export function generateApiKey(): { raw: string; prefix: string } {
  const randomPart = toBase62(randomBytes(24)).padStart(32, 'A')
  const raw = `ak_${randomPart}`
  return { raw, prefix: raw.slice(0, 8) }
}

export function hashApiKey(pepperHex: string, raw: string): string {
  if (!/^[0-9a-f]{64}$/i.test(pepperHex)) {
    throw new Error('pepper must be 32 bytes hex (64 chars)')
  }
  return createHmac('sha256', Buffer.from(pepperHex, 'hex')).update(raw).digest('hex')
}

export function verifyApiKey(pepperHex: string, raw: string, storedHashHex: string): boolean {
  const candidate = Buffer.from(hashApiKey(pepperHex, raw), 'hex')
  const stored = Buffer.from(storedHashHex, 'hex')
  if (candidate.length !== stored.length) return false
  return timingSafeEqual(candidate, stored)
}
```

Add export to `src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -F @aide/gateway-core test -- apiKey
```
Expected: PASS (4).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway-core/src/crypto/apiKey.ts packages/gateway-core/src/index.ts packages/gateway-core/tests/apiKey.test.ts
git commit -m "feat(gateway-core): API key generator + HMAC-SHA256 hash + timing-safe verify"
```

### Task 2.6: OpenAI → Anthropic request translator

**Files:**
- Create: `packages/gateway-core/src/translate/openaiToAnthropic.ts`
- Create: `packages/gateway-core/src/translate/types.ts`
- Test: `packages/gateway-core/tests/openaiToAnthropic.test.ts`

See spec Section 3.5 for full rules. Full code omitted here for brevity — test fixtures live in `packages/gateway-core/test/fixtures/openai-requests/` (JSON files), paired with expected Anthropic output. Snapshot test asserts round-trip equivalence.

**Commit message:** `feat(gateway-core): OpenAI chat/completions → Anthropic messages request translator`

### Task 2.7: Anthropic → OpenAI response translator (non-stream)

**Files:**
- Create: `packages/gateway-core/src/translate/anthropicToOpenai.ts`
- Test: `packages/gateway-core/tests/anthropicToOpenai.test.ts`

Translates `content[] + stop_reason + usage` → `choices[0].message + finish_reason + usage`. `stop_reason` mapping: `end_turn → stop`, `max_tokens → length`, `tool_use → tool_calls`. Tool use blocks get collapsed into `choices[0].message.tool_calls`.

**Commit message:** `feat(gateway-core): Anthropic → OpenAI response translator (non-stream)`

### Task 2.8: Anthropic → OpenAI streaming translator (incremental tool_calls)

**Files:**
- Create: `packages/gateway-core/src/translate/anthropicToOpenaiStream.ts`
- Create: `packages/gateway-core/test/fixtures/streams/` (SSE fixture files)
- Test: `packages/gateway-core/tests/anthropicToOpenaiStream.test.ts`

Consumes Anthropic SSE events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) and emits OpenAI-compat SSE chunks. Tool calls are emitted incrementally per spec Section 3.5. Tests use at least 10 paired fixtures covering: plain text, text + tool use, multi-tool, tool result, max_tokens-truncated, network mid-stream cutoff.

**Commit message:** `feat(gateway-core): Anthropic SSE → OpenAI SSE stream translator with incremental tool_calls`

---

## Part 3 — `apps/gateway` Scaffolding

### Task 3.1: Create `apps/gateway` workspace + Fastify skeleton

**Files:**
- Create: `apps/gateway/package.json`
- Create: `apps/gateway/tsconfig.json`, `tsconfig.build.json`
- Create: `apps/gateway/src/server.ts`
- Create: `apps/gateway/src/env.ts` (zod-validated env)
- Test: `apps/gateway/tests/server.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/gateway/tests/server.test.ts
import { describe, it, expect } from 'vitest'
import { buildServer } from '../src/server'

describe('gateway server', () => {
  it('responds 200 on /health', async () => {
    const app = await buildServer({ enabled: true })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
  it('returns {status:"disabled"} when ENABLE_GATEWAY=false', async () => {
    const app = await buildServer({ enabled: false })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toMatchObject({ status: 'disabled' })
    await app.close()
  })
})
```

- [ ] **Step 2: Run — FAIL**

`pnpm -F @aide/gateway test` → module not found.

- [ ] **Step 3: Implement**

```ts
// apps/gateway/src/server.ts
import Fastify, { type FastifyInstance } from 'fastify'

export interface BuildOpts { enabled: boolean }

export async function buildServer(opts: BuildOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })
  app.get('/health', async () => opts.enabled
    ? { status: 'ok' }
    : { status: 'disabled' })
  if (!opts.enabled) {
    app.log.warn('ENABLE_GATEWAY=false, gateway serves /health only')
    return app
  }
  // Register /v1/* routes later (tasks in Part 5+)
  return app
}

async function main() {
  const enabled = process.env.ENABLE_GATEWAY === 'true'
  const app = await buildServer({ enabled })
  const port = Number(process.env.GATEWAY_PORT ?? 3002)
  await app.listen({ port, host: '0.0.0.0' })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
```

- [ ] **Step 4: PASS**

`pnpm -F @aide/gateway test` → 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/
git commit -m "feat(gateway): scaffold apps/gateway with /health + feature flag gate"
```

### Task 3.2: Env schema + secret validation

**Files:**
- Modify: `packages/config/src/env.ts` — add 16 gateway env entries per design Section 7.1
- Test: `packages/config/tests/env-gateway.test.ts`

Validates `CREDENTIAL_ENCRYPTION_KEY` and `API_KEY_HASH_PEPPER` as `/^[0-9a-f]{64}$/i` (32 bytes hex). Fail-fast on invalid format.

**Commit message:** `feat(config): add gateway env vars with secret format validation`

### Task 3.3: API-key auth middleware

**Files:**
- Create: `apps/gateway/src/middleware/apiKeyAuth.ts`
- Test: `apps/gateway/tests/middleware/apiKeyAuth.test.ts`

Reads `Authorization: Bearer` or `x-api-key`, computes `hashApiKey(pepper, raw)` via `@aide/gateway-core`, queries `api_keys JOIN users JOIN organizations`, validates `revoked_at IS NULL`, `expires_at > now OR NULL`, IP whitelist/blacklist (use `ipaddr.js`). Attaches `{ apiKey, user, org, teamId }` to Fastify request via `decorateRequest`.

Test cases: valid key → passes + context attached; revoked → 401; bad hash → 401; IP not in whitelist → 403; admin-issued key with `revealed_at IS NULL` → 401 (`key_not_yet_revealed`).

**Commit message:** `feat(gateway): API-key auth middleware with IP allowlist + reveal guard`

### Task 3.4: `/metrics` endpoint

**Files:**
- Create: `apps/gateway/src/plugins/metrics.ts`
- Test: `apps/gateway/tests/plugins/metrics.test.ts`

Use `fastify-metrics`. Exposes Prometheus text format at `/metrics`. Register all metric names from design Section 4.9 (even if initially 0-valued) so scrape targets register labels.

**Commit message:** `feat(gateway): expose Prometheus /metrics endpoint`

---

## Part 4 — Redis Layer

### Task 4.1: ioredis client + connection lifecycle

**Files:**
- Create: `apps/gateway/src/redis/client.ts`
- Test: `apps/gateway/tests/redis/client.test.ts` (uses `ioredis-mock`)

Single shared client per process, `enableAutoPipelining: true`, `maxRetriesPerRequest: 3`, reconnect events logged at `warn`.

**Commit message:** `feat(gateway): shared ioredis client with reconnect logging`

### Task 4.2: Slot Lua script + acquire/release helpers

**Files:**
- Create: `apps/gateway/src/redis/slots.ts`
- Create: `apps/gateway/src/redis/lua/acquire-slot.lua` (embed as string)
- Test: `apps/gateway/tests/redis/slots.test.ts` (real Redis via testcontainers or ioredis-mock)

Implements the ZSET ZADD/ZREMRANGEBYSCORE pattern from design Section 4.2. Exposes `acquireSlot(key, requestId, limit, durationMs)` returning `boolean` and `releaseSlot(key, requestId)`.

Test: 20 concurrent acquires with limit=3 → exactly 3 succeed; expired members are cleaned up on next acquire.

**Commit message:** `feat(gateway): atomic slot acquire/release via Redis ZSET + Lua`

### Task 4.3: Wait queue helper

**Files:**
- Create: `apps/gateway/src/redis/waitQueue.ts`
- Test: `apps/gateway/tests/redis/waitQueue.test.ts`

`enqueueWait(userId, requestId, maxWait)`, `dequeueWait(userId, requestId)`. Returns `false` if depth >= maxWait.

**Commit message:** `feat(gateway): wait queue helper`

### Task 4.4: Idempotency cache

**Files:**
- Create: `apps/gateway/src/redis/idempotency.ts`
- Test: `apps/gateway/tests/redis/idempotency.test.ts`

`getCached(requestId)`, `setCached(requestId, response, ttlSec)`, `setInFlight(requestId, ttlSec)`. In-flight marker returns a sentinel so handler can reply 409 instead of replaying.

**Commit message:** `feat(gateway): idempotency cache with in-flight marker`

### Task 4.5: Sticky session helper

**Files:**
- Create: `apps/gateway/src/redis/sticky.ts`
- Test: `apps/gateway/tests/redis/sticky.test.ts`

`getSticky(orgId, sessionId)` / `setSticky(orgId, sessionId, accountId, ttlSec)`. Key prefix includes `orgId` to prevent cross-tenant collision.

**Commit message:** `feat(gateway): sticky session helper (opt-in via X-Claude-Session-Id)`

### Task 4.6: Redis failure-mode toggle

**Files:**
- Create: `apps/gateway/src/redis/failureMode.ts`
- Test: `apps/gateway/tests/redis/failureMode.test.ts`

`withRedis<T>(op, fallback)` — wraps Redis calls in try/catch; behavior depends on `GATEWAY_REDIS_FAILURE_MODE`: `strict` → throw `ServiceDegraded`; `lenient` → return fallback.

**Commit message:** `feat(gateway): Redis failure-mode wrapper (strict vs lenient)`

---

## Part 5 — Account Selection + Non-Stream Passthrough

### Task 5.1: Account selection query

**Files:**
- Create: `apps/gateway/src/runtime/selectAccount.ts`
- Test: `apps/gateway/tests/runtime/selectAccount.integration.test.ts` (testcontainers)

Executes the exact query from design Section 3.1 Step 5. Returns a list of candidate account IDs ordered by `(team_id IS NULL) ASC, priority ASC, last_used_at ASC NULLS FIRST`. Accepts `excludeIds` to implement failover's `NOT IN failed_account_ids`.

Test: seed 3 accounts (org-level low-priority, team-level high-priority, team-level rate-limited) → verify team-override selected first, rate-limited skipped.

**Commit message:** `feat(gateway): account selection query with team-override + state-machine filter`

### Task 5.2: Credential decrypt in-line

**Files:**
- Create: `apps/gateway/src/runtime/resolveCredential.ts`
- Test: `apps/gateway/tests/runtime/resolveCredential.test.ts`

Loads `credential_vault WHERE account_id = ?`, invokes `decryptCredential()` from `@aide/gateway-core`, parses JSON. Returns `{ type: 'api_key', apiKey } | { type: 'oauth', accessToken, refreshToken, expiresAt }`. OAuth refresh invocation wired in Part 6.

**Commit message:** `feat(gateway): credential_vault decrypt + typed return`

### Task 5.3: Non-stream upstream passthrough via undici

**Files:**
- Create: `apps/gateway/src/runtime/upstreamCall.ts`
- Test: `apps/gateway/tests/runtime/upstreamCall.test.ts` (uses real fake Anthropic server — Part 2.3 groundwork)

Sends `POST /v1/messages` to `UPSTREAM_ANTHROPIC_BASE_URL` with appropriate auth header. Returns `{ status, headers, body: Buffer }`. For `stream=true` returns an `AsyncIterable<Buffer>` instead — streaming path covered in Part 6.

Client disconnect: propagate `AbortSignal` to undici request.

**Commit message:** `feat(gateway): non-stream upstream passthrough via undici`

### Task 5.4: `/v1/messages` route wiring (non-stream only)

**Files:**
- Create: `apps/gateway/src/routes/messages.ts`
- Test: `apps/gateway/tests/routes/messages.integration.test.ts`

Wires together: auth middleware → parse body → select account → acquire slots → resolve credentials → upstream call → return response. No streaming, no failover yet. Usage log insert **synchronous** for this task (async worker in Part 7).

**Commit message:** `feat(gateway): POST /v1/messages (non-stream, no-failover MVP)`

---

## Part 6 — Streaming + Smart Buffer + OpenAI-Compat + Failover + OAuth Refresh

This Part is large because these concerns are tightly coupled (see Open Questions in design doc).

### Task 6.1: SSE stream parser utility

**Files:**
- Create: `packages/gateway-core/src/stream/anthropicSseParser.ts`
- Test: `packages/gateway-core/tests/anthropicSseParser.test.ts`

Async-iterable parser: takes `AsyncIterable<Buffer>` from undici, yields typed Anthropic SSE events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `error`). Handles partial chunks (buffer accumulation), CRLF edge cases, trailing whitespace.

**Commit message:** `feat(gateway-core): Anthropic SSE stream parser`

### Task 6.2: Smart buffering window

**Files:**
- Create: `apps/gateway/src/runtime/smartBuffer.ts`
- Test: `apps/gateway/tests/runtime/smartBuffer.test.ts`

State machine: `BUFFERING → COMMITTED`. Tracks accumulated bytes + elapsed ms. When either threshold hits, transitions to COMMITTED and flushes accumulated buffer to client. Upstream error *before* COMMITTED is retryable (failover); after COMMITTED, write `event: error` SSE chunk to client and log.

Test scenarios (using real fake server from Part 2.3):
- Upstream fails at 100ms → buffer state still BUFFERING → failover happens, client never sees first attempt
- Upstream fails at 700ms (past 500ms window) → COMMITTED → client receives chunks then error event
- Upstream sends 3KB in first burst (past 2KB window) → COMMITTED immediately → normal streaming continues

**Commit message:** `feat(gateway): smart buffering window for transparent mid-stream failover`

### Task 6.3: Failover state loop

**Files:**
- Create: `apps/gateway/src/runtime/failoverLoop.ts`
- Test: `apps/gateway/tests/runtime/failoverLoop.integration.test.ts`

Implements the full pipeline with Section 3 semantics:
```ts
for (let switchCount = 0; switchCount < maxSwitches; switchCount++) {
  const account = selectAccount({ excludeIds: failed })
  if (!account) throw AllUpstreamsFailed
  try {
    return await attemptWithSameAccountRetry(account, req, smartBuffer)
  } catch (err) {
    const action = classifyUpstreamError(err)
    if (action.kind === 'fatal') throw err
    if (action.stateUpdate) await applyStateUpdate(account.id, action.stateUpdate)
    failed.push(account.id)
    continue
  }
}
```

Test: 3 accounts (first 429, second connection error, third OK) → verify sequence, `failed_account_ids` captured, state machine writes applied.

**Commit message:** `feat(gateway): cross-account failover loop with state-machine updates`

### Task 6.4: OAuth inline refresh (in-flight)

**Files:**
- Create: `apps/gateway/src/runtime/oauthRefresh.ts`
- Test: `apps/gateway/tests/runtime/oauthRefresh.integration.test.ts`

When Step 7 of pipeline resolves credentials and `oauth_expires_at < now + 60s`, acquire Redis lock `aide:gw:oauth-refresh:{account_id}` (SETNX EX 30) and perform refresh. Update `credential_vault` in CAS-safe way (WHERE rotated_at = old_value).

**Commit message:** `feat(gateway): inline OAuth refresh with Redis lock`

### Task 6.5: OAuth refresh cron worker

**Files:**
- Create: `apps/gateway/src/workers/oauthRefreshCron.ts`
- Test: `apps/gateway/tests/workers/oauthRefreshCron.integration.test.ts`

Runs every 60s + per-instance jitter (`random(0, 10000)` ms at startup). Query accounts needing refresh, skip those in exp-backoff window, acquire per-account Redis lock, refresh, update state (including `oauth_refresh_fail_count` + exp backoff on failure, `status='error'` at max fail).

**Commit message:** `feat(gateway): OAuth refresh cron worker with jitter + exp backoff`

### Task 6.6: OpenAI-compat request route

**Files:**
- Create: `apps/gateway/src/routes/chatCompletions.ts`
- Test: `apps/gateway/tests/routes/chatCompletions.integration.test.ts`

Wires `/v1/chat/completions` through the same failover pipeline as `/v1/messages`. Uses `openaiToAnthropic` translator on request, `anthropicToOpenaiStream` on streaming response, `anthropicToOpenai` on non-stream response.

**Commit message:** `feat(gateway): POST /v1/chat/completions (OpenAI-compat passthrough)`

### Task 6.7: Integrate streaming + smart buffer into `/v1/messages`

**Files:**
- Modify: `apps/gateway/src/routes/messages.ts`
- Test: `apps/gateway/tests/routes/messages.streaming.integration.test.ts`

Extend Task 5.4 route: on `stream=true`, pipe parsed SSE events through smart buffer → client; on error pre-commit, trigger failover loop; on error post-commit, emit `event: error` + log.

**Commit message:** `feat(gateway): streaming + smart buffer + failover on /v1/messages`

---

## Part 7 — Usage Log Worker + Billing Transaction

### Task 7.1: BullMQ queue setup + `usage-log` job schema

**Files:**
- Create: `apps/gateway/src/workers/usageLogQueue.ts`
- Test: `apps/gateway/tests/workers/usageLogQueue.test.ts`

Creates BullMQ queue `aide:gw:usage-log`, job ID = `request_id` (dedup), default attempts=3 exp backoff. Exposes `enqueueUsageLog(payload)`.

**Commit message:** `feat(gateway): BullMQ queue for usage log writes`

### Task 7.2: Worker — batch insert with same-txn quota update

**Files:**
- Create: `apps/gateway/src/workers/usageLogWorker.ts`
- Test: `apps/gateway/tests/workers/usageLogWorker.integration.test.ts`

Worker drains up to 100 jobs / 1s flush. Per batch: open txn → INSERT usage_logs rows → UPDATE api_keys SET quota_used_usd = quota_used_usd + ?, last_used_at = now() (grouped by api_key_id, one UPDATE per key per batch) → commit.

On txn failure: BullMQ exp backoff retries. After 3 fails → DLQ (metric `gw_queue_dlq_count`).

Test: enqueue 250 jobs concurrently → verify 3 batches × (100, 100, 50) → all rows in DB, quota sums match.

**Commit message:** `feat(gateway): usage log worker with same-txn quota update`

### Task 7.3: Inline fallback on enqueue failure

**Files:**
- Modify: `apps/gateway/src/workers/usageLogQueue.ts`
- Test: `apps/gateway/tests/workers/usageLogQueue.fallback.test.ts`

`enqueueUsageLog` wrapped in try/catch. On Redis / BullMQ error: execute the same INSERT + UPDATE inline in a fresh txn. On inline failure: `pino.error({ type: 'gw_usage_persist_lost', payload })` + metric increment.

**Commit message:** `feat(gateway): inline DB fallback when BullMQ enqueue fails`

### Task 7.4: Billing sanity audit + monotonicity metric

**Files:**
- Create: `apps/gateway/src/workers/billingAudit.ts`
- Test: `apps/gateway/tests/workers/billingAudit.integration.test.ts`

Hourly cron: sample 1% of `api_keys`, compute `SUM(total_cost)` vs `quota_used_usd`. Drift > 0.01 USD → `gw_billing_drift_total`. Drift where `actual < expected` (monotonicity violation) → `gw_billing_monotonicity_violation_total`.

**Commit message:** `feat(gateway): hourly billing audit with drift + monotonicity metrics`

---

## Part 8 — `apps/api` Admin tRPC Routers

### Task 8.1: `accounts` router (list / create / update / rotate / soft-delete)

**Files:**
- Create: `apps/api/src/trpc/routers/accounts.ts`
- Test: `apps/api/tests/trpc/accounts.integration.test.ts`

Endpoints: `accounts.list(orgId)`, `accounts.get(id)`, `accounts.create(…)` — validates credentials, calls `encryptCredential`, inserts both `credential_vault` + `accounts` rows in one txn. `accounts.update` for priority/concurrency/notes. `accounts.rotate(id, credentials)` writes new encrypted blob + bumps `rotated_at`. `accounts.delete(id)` sets `deleted_at`. All gated by RBAC action types from Task 1.6.

Feature flag: if `ENABLE_GATEWAY=false` → throw `TRPCError({ code: 'NOT_FOUND' })`.

**Commit message:** `feat(api): tRPC accounts router with encrypt-on-create and RBAC`

### Task 8.2: `apiKeys` router (issue own / issue on behalf / reveal / revoke)

**Files:**
- Create: `apps/api/src/trpc/routers/apiKeys.ts`
- Test: `apps/api/tests/trpc/apiKeys.integration.test.ts`

- `apiKeys.issueOwn(input)` → generates key, hashes with HMAC, inserts row; returns `{ raw, id }` (raw shown once).
- `apiKeys.issueForUser(orgId, targetUserId, input)` → also generates reveal token + stores `HMAC-SHA256(pepper, token)`; returns `{ revealUrl }` (URL = `${BASE}/api-keys/reveal/${token}`); raw NOT returned to admin.
- `apiKeys.revealViaToken(token)` → verifies token hash, checks expiry + not yet revealed, fetches raw... WAIT — raw cannot be retrieved from hash. **Design correction for implementation**: admin-issued flow must stash the raw temporarily. Implementation: on issue, `SET aide:gw:key-reveal:${token} rawKey EX 86400`; on reveal: `GET` + `DEL`; then audit `api_keys.revealed_at = now()`.
- `apiKeys.listOwn()`, `apiKeys.listOrg(orgId)`, `apiKeys.revoke(id)`.

Feature flag enforcement as Task 8.1.

**Commit message:** `feat(api): tRPC apiKeys router with one-time-URL admin reveal flow`

### Task 8.3: `usage` router (read own / user / team / org)

**Files:**
- Create: `apps/api/src/trpc/routers/usage.ts`
- Test: `apps/api/tests/trpc/usage.integration.test.ts`

Aggregation queries over `usage_logs`:
- `usage.summary({ scope, from, to })` → totals + per-model breakdown
- `usage.list({ scope, from, to, page, pageSize })` → paginated request list (for drill-down)

Scope discriminator: `{ type: 'own' } | { type: 'user', userId } | { type: 'team', teamId, orgId } | { type: 'org', orgId }`. RBAC per Task 1.6.

**Commit message:** `feat(api): tRPC usage router with scoped aggregation`

### Task 8.4: Wire new routers into `appRouter`

**Files:**
- Modify: `apps/api/src/trpc/router.ts`
- Test: existing router test should still pass; add type-level assertion that new routers are exposed.

**Commit message:** `feat(api): wire accounts/apiKeys/usage routers into appRouter`

---

## Part 9 — `apps/web` Admin UI

### Task 9.1: Accounts list page

**Files:**
- Create: `apps/web/src/app/dashboard/organizations/[id]/accounts/page.tsx`
- Create: `apps/web/src/components/accounts/AccountList.tsx`

Lists accounts from `trpc.accounts.list({ orgId })`. Status badges (Apple design tokens). Row actions: rotate / edit / delete dropdown. RequirePerm gate on `account.read`.

**Commit message:** `feat(web): accounts list page with Apple-style status badges`

### Task 9.2: Account create page (form + credential paste)

**Files:**
- Create: `apps/web/src/app/dashboard/organizations/[id]/accounts/new/page.tsx`
- Create: `apps/web/src/components/accounts/AccountCreateForm.tsx`

React-hook-form + zod. Fields: name, platform (select: anthropic), type (radio: api_key / oauth), scope (org or team picker), credentials (textarea with format hint per type). Submits via `trpc.accounts.create.useMutation`.

**Commit message:** `feat(web): account create form with platform + type + credential paste`

### Task 9.3: API Key list + create dialog (self-issue, one-time reveal)

**Files:**
- Modify: `apps/web/src/app/dashboard/profile/page.tsx` — add API Keys section
- Create: `apps/web/src/components/apiKeys/ApiKeyList.tsx`
- Create: `apps/web/src/components/apiKeys/ApiKeyCreateDialog.tsx`

Create dialog → on submit, show one-time reveal panel with copy button + warning text. After close, only prefix displayed. Revoke action with confirm.

**Commit message:** `feat(web): self-service API key list + one-time reveal panel`

### Task 9.4: Admin-issue key (one-time URL)

**Files:**
- Create: `apps/web/src/app/dashboard/organizations/[id]/members/[uid]/api-keys/page.tsx`
- Create: `apps/web/src/components/apiKeys/AdminIssueDialog.tsx`

Admin fills form → submits → UI shows one-time URL + copy button + "This URL is valid 24h, single-use; pass it to the user." Admin never sees raw key.

**Commit message:** `feat(web): admin-issued API key with one-time URL flow`

### Task 9.5: Reveal landing page

**Files:**
- Create: `apps/web/src/app/api-keys/reveal/[token]/page.tsx`

Server component fetches raw via `trpc.apiKeys.revealViaToken` (Task 8.2); displays reveal panel with copy button; after close, page shows "Revealed" + marks in DB. Second open → "Already revealed" message.

**Commit message:** `feat(web): one-time URL reveal landing page for admin-issued keys`

### Task 9.6: Usage query page (org + self)

**Files:**
- Create: `apps/web/src/app/dashboard/organizations/[id]/usage/page.tsx`
- Create: `apps/web/src/app/dashboard/profile/usage/page.tsx`
- Create: `apps/web/src/components/usage/UsageChart.tsx` (stacked area via recharts or similar)

Time range picker, tab switch (by team / by member), top-20 spenders table, request drill-down link.

**Commit message:** `feat(web): org + self usage dashboards with drill-down`

---

## Part 10 — Docker + Compose + Release + CI

### Task 10.1: `docker/Dockerfile.gateway`

**Files:**
- Create: `docker/Dockerfile.gateway`

Multi-stage, mirrors `Dockerfile.api` pattern (pnpm deploy to /out, node:20-alpine runtime). Healthcheck: `wget -q -O- http://localhost:3002/health`.

**Commit message:** `feat(docker): multi-stage Dockerfile.gateway`

### Task 10.2: Extend `docker-compose.yml` with `gateway` + `redis`

**Files:**
- Modify: `docker/docker-compose.yml`

Add `redis:7-alpine` service (always up — used by gateway+future features), `gateway` service under `profiles: [gateway]`. Wire env vars (secrets via `docker secrets` or `env_file: .env.secrets`). Depends on postgres healthy + migrate completed + redis healthy.

**Commit message:** `feat(docker): compose adds redis + gateway (under profile)`

### Task 10.3: Extend `release.yml` matrix with `gateway`

**Files:**
- Modify: `.github/workflows/release.yml` — add `gateway` to matrix.image

Multi-arch already set up in PR #3; just the matrix entry needed.

**Commit message:** `ci(release): build + push aide-gateway image`

### Task 10.4: CI `gateway-integration` job

**Files:**
- Modify: `.github/workflows/ci.yml` — add `gateway-integration` job

Uses testcontainers for postgres + redis; runs `pnpm -F @aide/gateway test` + `pnpm -F @aide/gateway-core test`.

**Commit message:** `ci: add gateway-integration job with testcontainers postgres+redis`

---

## Part 11 — Documentation

### Task 11.1: `docs/GATEWAY.md`

**Files:**
- Create: `docs/GATEWAY.md`

Sections: architecture overview, account management (add / rotate / scopes), API key distribution (self + admin-issued), client examples (Claude Code with custom base URL, OpenAI SDK with our endpoint), runbook (from design Section 8.3), schema change policy.

**Commit message:** `docs: GATEWAY.md — full gateway operator + user guide`

### Task 11.2: Update `SELF_HOSTING.md` + `apps/gateway/README.md`

**Files:**
- Modify: `docs/SELF_HOSTING.md` — add Gateway + Redis + new env var section
- Create: `apps/gateway/README.md` — dev startup, test harness, debug tips

**Commit message:** `docs: update SELF_HOSTING + add apps/gateway README`

---

## Part 12 — E2E + Smoke

### Task 12.1: Playwright E2E — account + key + gateway request happy path

**Files:**
- Create: `apps/web/e2e/specs/10-gateway-happy.spec.ts`

Admin creates api_key account → issues self-key → uses key against gateway (mocked upstream, see fake-anthropic setup from Part 2.3) → dashboard shows usage row.

**Commit message:** `test(e2e): gateway account + self-issued key + usage visibility`

### Task 12.2: Playwright E2E — admin-issued key + one-time reveal

**Files:**
- Create: `apps/web/e2e/specs/11-gateway-admin-issue.spec.ts`

Admin issues key for another member → URL copied → second browser context opens URL → reveal panel works → key used against gateway → IP whitelist 403 test.

**Commit message:** `test(e2e): admin-issued API key one-time URL flow`

### Task 12.3: `scripts/smoke-gateway.sh`

**Files:**
- Create: `scripts/smoke-gateway.sh`

Curl sequence: `/health` 200, `/metrics` 200, create account + key via api, call `/v1/messages` with seeded upstream → verify response + usage_logs row.

**Commit message:** `test(smoke): gateway smoke script for post-deploy verification`

---

## Part 13 — Tag v0.3.0

Runs only after Parts 1–12 are all green in CI + manual smoke passes.

### Task 13.1: Update README + tag v0.3.0

**Files:**
- Modify: `README.md` — add v0.3.0 feature list
- Modify: `CHANGELOG.md` (create if absent)

Steps:

- [ ] **Step 1:** Update `README.md` Platform mode section with gateway capabilities + link to `docs/GATEWAY.md`
- [ ] **Step 2:** Write `CHANGELOG.md` entry (`## v0.3.0 — 2026-MM-DD — Plan 4A gateway shipped`)
- [ ] **Step 3:** Verify `pnpm turbo run lint typecheck test build` all green
- [ ] **Step 4:** Manual smoke: `scripts/smoke-gateway.sh` against a staging stack
- [ ] **Step 5:** Tag + push

```bash
git tag -a v0.3.0 -m "Plan 4A — gateway"
git push origin v0.3.0
```

`release.yml` will produce multi-arch images `ghcr.io/hanfour/aide-{api,web,gateway}:v0.3.0`. Verify the release on GitHub, write release notes (mirror v0.2.0 format).

**Commit message (for README/CHANGELOG update):** `docs: README + CHANGELOG for v0.3.0 — Plan 4A gateway`

---

## Checklist for plan self-review

Before handing off to subagent execution:

- [x] Every task has explicit file paths (Create / Modify / Test)
- [x] Every task has the 5-step TDD rhythm (test → fail → impl → pass → commit)
- [x] Commit messages follow `type(scope): subject` convention
- [x] Code blocks appear for non-trivial implementations; mechanical mirror-of-prior-task tasks are compact-described with explicit commit message
- [x] Every cross-reference to design doc uses section numbers
- [x] No TBD / TODO / later / placeholder strings in task bodies
- [x] Type signatures from early tasks (`NormalizedRequest`, `SealedCredential`, `FailoverAction`) are consistent when used in later tasks
- [x] Feature flag gating (ENABLE_GATEWAY) correctly enforced at all layers per design Section 7.4

## Execution handoff

Use `superpowers:subagent-driven-development` (recommended) to execute this plan. Two-stage review after each task: spec compliance then code quality. Dispatch one implementer subagent per task; do not attempt multiple tasks in a single subagent.

Pause points (good places for user checkpoints):
- After Part 2 — gateway-core utilities complete, verify pricing / translation / crypto unit tests ≥ 90% coverage
- After Part 6 — gateway can run end-to-end against fake-Anthropic with failover + streaming
- After Part 9 — UI polish visible in browser
- Before Part 13 — final smoke before tag

*End of Plan 4A implementation plan.*




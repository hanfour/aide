# Plan 4B — Evaluator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Plan 4A loop. Opt-in body capture on `apps/gateway` + daily evaluator cron that turns captured content + `usage_logs` into per-member `evaluation_reports`, matching CLI rubric depth while respecting labor-law transparency.

**Architecture:** Content capture piggybacks on Plan 4A's request pipeline (Step 10a). Bodies encrypted with AES-256-GCM / HKDF (reusing `CREDENTIAL_ENCRYPTION_KEY` with `info="aide-gateway-body-v1"`). Rule-based scoring engine lives in new `packages/evaluator` (pure logic). LLM Deep Analysis is opt-in, dogfooded via the org's own upstream account. Members see own full reports; admins see their scope; super_admin sees platform aggregates only.

**Tech Stack:** `zod`, `drizzle-orm`, `bullmq`, `@aide/gateway-core` cipher (existing), Claude via self-gateway. Vitest for unit + testcontainers for integration.

**Design reference:** [`.claude/plans/2026-04-22-plan-4b-evaluator-design.md`](./2026-04-22-plan-4b-evaluator-design.md) — 891-line spec with 14-item decision log.

**Target release:** v0.4.0

**Task count:** 55 tasks across 14 parts. Each task is 5 steps (failing test → verify fail → minimal impl → verify pass → commit), 2–5 minutes per step. Total estimate ~2 weeks subagent-driven.

---

## Part 1 — Schema + Migration + RBAC

Goal: land the 3 new tables + `organizations` ALTER + 1 soft-delete queue + RBAC extensions. No runtime code yet.

### Task 1.1: `organizations` content-capture columns

**Files:**
- Modify: `packages/db/src/schema/org.ts`
- Test: `packages/db/tests/schema/organizations-capture.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/schema/organizations-capture.test.ts
import { describe, it, expect } from 'vitest'
import { organizations } from '../../src/schema/org'

describe('organizations — content capture columns', () => {
  it('exposes capture toggle, retention override, LLM eval binding, capture_thinking, rubric link, leaderboard', () => {
    const cols = Object.keys(organizations)
    for (const c of [
      'contentCaptureEnabled', 'contentCaptureEnabledAt', 'contentCaptureEnabledBy',
      'retentionDaysOverride', 'llmEvalEnabled', 'llmEvalAccountId', 'llmEvalModel',
      'captureThinking', 'rubricId', 'leaderboardEnabled',
    ]) {
      expect(cols).toContain(c)
    }
  })
})
```

- [ ] **Step 2: Run — FAIL** (`pnpm -F @aide/db test -- organizations-capture`).

- [ ] **Step 3: Implement**

Append to `packages/db/src/schema/org.ts` inside `organizations = pgTable('organizations', { ... })`:

```ts
  // Content-capture (Plan 4B)
  contentCaptureEnabled: boolean('content_capture_enabled').notNull().default(false),
  contentCaptureEnabledAt: timestamp('content_capture_enabled_at', { withTimezone: true }),
  contentCaptureEnabledBy: uuid('content_capture_enabled_by'),  // FK to users.id set in migration; keep loose here to avoid circular
  retentionDaysOverride: integer('retention_days_override'),
  llmEvalEnabled: boolean('llm_eval_enabled').notNull().default(false),
  llmEvalAccountId: uuid('llm_eval_account_id'),   // FK to upstream_accounts.id, loose for same reason
  llmEvalModel: text('llm_eval_model'),
  captureThinking: boolean('capture_thinking').notNull().default(false),
  rubricId: uuid('rubric_id'),                      // FK to rubrics.id — we'll add this table next
  leaderboardEnabled: boolean('leaderboard_enabled').notNull().default(false),
```

- [ ] **Step 4: Run — PASS**.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/org.ts packages/db/tests/schema/organizations-capture.test.ts
git commit -m "feat(db): organizations content-capture columns (Plan 4B)"
```

### Task 1.2: `rubrics` schema

**Files:**
- Create: `packages/db/src/schema/rubrics.ts`
- Test: `packages/db/tests/schema/rubrics.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/schema/rubrics.test.ts
import { describe, it, expect } from 'vitest'
import { rubrics } from '../../src/schema/rubrics'

describe('rubrics schema', () => {
  it('exports table with definition JSONB + is_default + soft delete', () => {
    const cols = Object.keys(rubrics)
    for (const c of [
      'id', 'orgId', 'name', 'description', 'version',
      'definition', 'isDefault', 'createdBy',
      'createdAt', 'updatedAt', 'deletedAt',
    ]) {
      expect(cols).toContain(c)
    }
  })
})
```

- [ ] **Step 2: Run — FAIL**.

- [ ] **Step 3: Implement**

```ts
// packages/db/src/schema/rubrics.ts
import { pgTable, uuid, text, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations } from './org.js'
import { users } from './auth.js'

export const rubrics = pgTable('rubrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  version: text('version').notNull(),
  definition: jsonb('definition').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  orgIdx: index('rubrics_org_idx').on(t.orgId).where(sql`${t.deletedAt} IS NULL`),
  defaultIdx: index('rubrics_default_idx').on(t.isDefault).where(sql`${t.isDefault} = true`),
}))
```

Add export to `packages/db/src/schema/index.ts`.

- [ ] **Step 4: Run — PASS**.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/rubrics.ts packages/db/src/schema/index.ts packages/db/tests/schema/rubrics.test.ts
git commit -m "feat(db): add rubrics schema (Plan 4B)"
```

### Task 1.3: `request_bodies` schema

**Files:**
- Create: `packages/db/src/schema/requestBodies.ts`
- Test: `packages/db/tests/schema/requestBodies.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/schema/requestBodies.test.ts
import { describe, it, expect } from 'vitest'
import { requestBodies } from '../../src/schema/requestBodies'

describe('requestBodies schema', () => {
  it('exports encrypted body columns + cleartext metadata + retention', () => {
    const cols = Object.keys(requestBodies)
    for (const c of [
      'requestId', 'orgId',
      'requestBodySealed', 'responseBodySealed', 'thinkingBodySealed', 'attemptErrorsSealed',
      'requestParams', 'stopReason', 'clientUserAgent', 'clientSessionId',
      'attachmentsMeta', 'cacheControlMarkers',
      'toolResultTruncated', 'bodyTruncated',
      'capturedAt', 'retentionUntil',
    ]) {
      expect(cols).toContain(c)
    }
  })
})
```

- [ ] **Step 2: Run — FAIL**.

- [ ] **Step 3: Implement**

```ts
// packages/db/src/schema/requestBodies.ts
import { pgTable, text, uuid, jsonb, customType, boolean, timestamp, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations } from './org.js'
import { usageLogs } from './usageLogs.js'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

export const requestBodies = pgTable('request_bodies', {
  requestId: text('request_id').primaryKey().references(() => usageLogs.requestId, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  requestBodySealed: bytea('request_body_sealed').notNull(),
  responseBodySealed: bytea('response_body_sealed').notNull(),
  thinkingBodySealed: bytea('thinking_body_sealed'),
  attemptErrorsSealed: bytea('attempt_errors_sealed'),
  requestParams: jsonb('request_params'),
  stopReason: text('stop_reason'),
  clientUserAgent: text('client_user_agent'),
  clientSessionId: text('client_session_id'),
  attachmentsMeta: jsonb('attachments_meta'),
  cacheControlMarkers: jsonb('cache_control_markers'),
  toolResultTruncated: boolean('tool_result_truncated').notNull().default(false),
  bodyTruncated: boolean('body_truncated').notNull().default(false),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  retentionUntil: timestamp('retention_until', { withTimezone: true }).notNull(),
}, (t) => ({
  retentionIdx: index('request_bodies_retention_idx').on(t.retentionUntil),
  orgTimeIdx: index('request_bodies_org_time_idx').on(t.orgId, t.capturedAt),
}))
```

Add export to schema index.

- [ ] **Step 4: Run — PASS**.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/requestBodies.ts packages/db/src/schema/index.ts packages/db/tests/schema/requestBodies.test.ts
git commit -m "feat(db): add request_bodies schema (encrypted, 90-day retention)"
```

### Task 1.4: `evaluation_reports` schema

**Files:**
- Create: `packages/db/src/schema/evaluationReports.ts`
- Test: `packages/db/tests/schema/evaluationReports.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/schema/evaluationReports.test.ts
import { describe, it, expect } from 'vitest'
import { evaluationReports } from '../../src/schema/evaluationReports'

describe('evaluationReports schema', () => {
  it('exports rule-based fields + optional LLM fields + trigger audit', () => {
    const cols = Object.keys(evaluationReports)
    for (const c of [
      'id', 'orgId', 'userId', 'teamId',
      'periodStart', 'periodEnd', 'periodType',
      'rubricId', 'rubricVersion',
      'totalScore', 'sectionScores', 'signalsSummary', 'dataQuality',
      'llmNarrative', 'llmEvidence', 'llmModel', 'llmCalledAt', 'llmCostUsd', 'llmUpstreamAccountId',
      'triggeredBy', 'triggeredByUser',
      'createdAt', 'updatedAt',
    ]) {
      expect(cols).toContain(c)
    }
  })
})
```

- [ ] **Step 2: Run — FAIL**.

- [ ] **Step 3: Implement**

```ts
// packages/db/src/schema/evaluationReports.ts
import { pgTable, uuid, text, jsonb, timestamp, decimal, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { organizations, teams } from './org.js'
import { users } from './auth.js'
import { rubrics } from './rubrics.js'
import { upstreamAccounts } from './accounts.js'

export const evaluationReports = pgTable('evaluation_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  periodType: text('period_type').notNull(),
  rubricId: uuid('rubric_id').notNull().references(() => rubrics.id, { onDelete: 'restrict' }),
  rubricVersion: text('rubric_version').notNull(),
  totalScore: decimal('total_score', { precision: 10, scale: 4 }).notNull(),
  sectionScores: jsonb('section_scores').notNull(),
  signalsSummary: jsonb('signals_summary').notNull(),
  dataQuality: jsonb('data_quality').notNull(),
  llmNarrative: text('llm_narrative'),
  llmEvidence: jsonb('llm_evidence'),
  llmModel: text('llm_model'),
  llmCalledAt: timestamp('llm_called_at', { withTimezone: true }),
  llmCostUsd: decimal('llm_cost_usd', { precision: 20, scale: 10 }),
  llmUpstreamAccountId: uuid('llm_upstream_account_id').references(() => upstreamAccounts.id, { onDelete: 'set null' }),
  triggeredBy: text('triggered_by').notNull(),
  triggeredByUser: uuid('triggered_by_user').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userTimeIdx: index('evaluation_reports_user_time_idx').on(t.userId, t.periodStart),
  orgTimeIdx: index('evaluation_reports_org_time_idx').on(t.orgId, t.periodStart),
  teamTimeIdx: index('evaluation_reports_team_time_idx').on(t.teamId, t.periodStart),
  periodUniq: uniqueIndex('evaluation_reports_period_uniq').on(t.userId, t.periodStart, t.periodType),
}))
```

Add export to schema index.

- [ ] **Step 4: Run — PASS**.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/evaluationReports.ts packages/db/src/schema/index.ts packages/db/tests/schema/evaluationReports.test.ts
git commit -m "feat(db): add evaluation_reports schema (perpetual retention, upsert on rerun)"
```

### Task 1.5: `gdpr_delete_requests` schema

**Files:**
- Create: `packages/db/src/schema/gdprDeleteRequests.ts`
- Test: `packages/db/tests/schema/gdprDeleteRequests.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/tests/schema/gdprDeleteRequests.test.ts
import { describe, it, expect } from 'vitest'
import { gdprDeleteRequests } from '../../src/schema/gdprDeleteRequests'

describe('gdprDeleteRequests schema', () => {
  it('exports request/approval/execution tracking columns', () => {
    const cols = Object.keys(gdprDeleteRequests)
    for (const c of [
      'id', 'orgId', 'userId',
      'requestedAt', 'requestedByUserId', 'reason',
      'approvedAt', 'approvedByUserId',
      'rejectedAt', 'rejectedReason',
      'executedAt', 'scope',
    ]) {
      expect(cols).toContain(c)
    }
  })
})
```

- [ ] **Step 2: Run — FAIL**.

- [ ] **Step 3: Implement**

```ts
// packages/db/src/schema/gdprDeleteRequests.ts
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core'
import { organizations } from './org.js'
import { users } from './auth.js'

export const gdprDeleteRequests = pgTable('gdpr_delete_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  rejectedReason: text('rejected_reason'),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  scope: text('scope').notNull(),  // 'bodies' | 'bodies_and_reports'
}, (t) => ({
  pendingIdx: index('gdpr_delete_pending_idx').on(t.requestedAt),
  approvedIdx: index('gdpr_delete_approved_idx').on(t.approvedAt),
}))
```

Add export to schema index.

- [ ] **Step 4: Run — PASS**.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/gdprDeleteRequests.ts packages/db/src/schema/index.ts packages/db/tests/schema/gdprDeleteRequests.test.ts
git commit -m "feat(db): add gdpr_delete_requests queue (member-initiated wipes)"
```

### Task 1.6: Generate + verify migration 0002

**Files:**
- Create: `packages/db/drizzle/0002_*.sql` (drizzle-kit auto-names)
- Test: `packages/db/tests/schema/migration0002.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

describe('migration 0002 — evaluator schema', () => {
  const drizzleDir = join(__dirname, '../../drizzle')
  const file = readdirSync(drizzleDir).find((f) => f.startsWith('0002_') && f.endsWith('.sql'))
  if (!file) throw new Error('Migration 0002_* not found — run pnpm -F @aide/db db:generate')
  const sql = readFileSync(join(drizzleDir, file), 'utf8')

  it('creates the 4 new tables', () => {
    expect(sql).toMatch(/CREATE TABLE.*"rubrics"/)
    expect(sql).toMatch(/CREATE TABLE.*"request_bodies"/)
    expect(sql).toMatch(/CREATE TABLE.*"evaluation_reports"/)
    expect(sql).toMatch(/CREATE TABLE.*"gdpr_delete_requests"/)
  })
  it('alters organizations with capture columns', () => {
    expect(sql).toMatch(/ALTER TABLE "organizations" ADD COLUMN "content_capture_enabled"/)
  })
  it('creates hot-path indexes', () => {
    expect(sql).toMatch(/CREATE INDEX.*request_bodies_retention_idx/)
    expect(sql).toMatch(/CREATE INDEX.*evaluation_reports_user_time_idx/)
  })
})
```

- [ ] **Step 2: Run — FAIL** (file missing).

- [ ] **Step 3: Generate**

```bash
pnpm -F @aide/db db:generate
```

Verify the generated SQL contains all of the above. If drizzle groups them across multiple migrations (unlikely for one schema change batch), consolidate by hand if needed, but prefer drizzle's output.

- [ ] **Step 4: Run — PASS**.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/ packages/db/tests/schema/migration0002.test.ts
git commit -m "feat(db): generate migration 0002 for evaluator schema"
```

### Task 1.7: Extend RBAC actions

**Files:**
- Modify: `packages/auth/src/rbac/actions.ts`
- Modify: `packages/auth/src/rbac/check.ts`
- Test: `packages/auth/tests/unit/rbac/evaluator-actions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import type { Action } from '../../../src/rbac/actions'

describe('RBAC — evaluator actions', () => {
  it('compiles with new capture / rubric / report / evaluator variants', () => {
    const samples: Action[] = [
      { type: 'content_capture.read', orgId: 'x' },
      { type: 'content_capture.toggle', orgId: 'x' },
      { type: 'report.read_own' },
      { type: 'report.read_user', orgId: 'x', targetUserId: 'u' },
      { type: 'report.read_team', orgId: 'x', teamId: 't' },
      { type: 'report.read_org', orgId: 'x' },
      { type: 'report.rerun', orgId: 'x', targetUserId: 'u', periodStart: '2026-04-22' },
      { type: 'report.export_own' },
      { type: 'report.delete_own' },
      { type: 'rubric.read', orgId: 'x' },
      { type: 'rubric.create', orgId: 'x' },
      { type: 'rubric.update', orgId: 'x', rubricId: 'r' },
      { type: 'rubric.delete', orgId: 'x', rubricId: 'r' },
      { type: 'evaluator.read_status', orgId: 'x' },
    ]
    expect(samples.length).toBe(14)
  })
})
```

- [ ] **Step 2: Run — FAIL** (TS type errors).

- [ ] **Step 3: Extend union and `can()`**

In `actions.ts` append to the `Action` union:

```ts
  | { type: 'content_capture.read'; orgId: string }
  | { type: 'content_capture.toggle'; orgId: string }
  | { type: 'report.read_own' }
  | { type: 'report.read_user'; orgId: string; targetUserId: string }
  | { type: 'report.read_team'; orgId: string; teamId: string }
  | { type: 'report.read_org'; orgId: string }
  | { type: 'report.rerun'; orgId: string; targetUserId: string; periodStart: string }
  | { type: 'report.export_own' }
  | { type: 'report.delete_own' }
  | { type: 'rubric.read'; orgId: string }
  | { type: 'rubric.create'; orgId: string }
  | { type: 'rubric.update'; orgId: string; rubricId: string }
  | { type: 'rubric.delete'; orgId: string; rubricId: string }
  | { type: 'evaluator.read_status'; orgId: string }
```

In `check.ts` add cases — follow the existing pattern (super_admin short-circuit already at top):

- `content_capture.read` / `content_capture.toggle` / `rubric.*` / `report.read_org` / `report.read_user` / `report.rerun` / `evaluator.read_status` → require `org_admin` at `orgId`
- `report.read_team` → require `team_manager` at `teamId` or `org_admin` at `orgId`
- `report.read_own` / `report.export_own` / `report.delete_own` → always `true` (authenticated self-only; enforced at caller)

- [ ] **Step 4: Run — PASS** (existing `packages/auth` tests + this new one).

- [ ] **Step 5: Commit**

```bash
git add packages/auth/src/rbac/actions.ts packages/auth/src/rbac/check.ts packages/auth/tests/unit/rbac/evaluator-actions.test.ts
git commit -m "feat(auth): extend RBAC with content_capture/report/rubric/evaluator actions"
```

---

## Part 2 — `packages/evaluator` Pure Logic

Goal: new workspace package `@aide/evaluator`. Pure TS, no Fastify/DB, zero side effects. Mirrors `@aide/gateway-core` convention: unit-tested with fixtures.

### Task 2.1: Scaffold `packages/evaluator`

**Files:**
- Create: `packages/evaluator/package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`
- Create: `packages/evaluator/src/index.ts` (empty export)
- Create: `packages/evaluator/tests/scaffold.test.ts`

Mirror the pattern in `packages/gateway-core/` exactly. `package.json` points `main`/`types` to `dist/` (same convention as gateway-core so CI's build step picks it up).

Commit: `feat(evaluator): scaffold workspace package`

### Task 2.2: Rubric Zod schema + validator

**Files:**
- Create: `packages/evaluator/src/rubric/schema.ts`
- Test: `packages/evaluator/tests/rubricSchema.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/evaluator/tests/rubricSchema.test.ts
import { describe, it, expect } from 'vitest'
import { rubricSchema } from '../src/rubric/schema'

describe('rubricSchema', () => {
  const valid = {
    name: 'test',
    version: '1.0.0',
    sections: [{
      id: 'interaction',
      name: 'Interaction',
      weight: '50%',
      standard: { score: 100, label: 'Standard', criteria: ['c1'] },
      superior: { score: 120, label: 'Superior', criteria: ['c2'] },
      signals: [
        { type: 'keyword', id: 'kw1', in: 'request_body', terms: ['option', 'compare'] },
        { type: 'threshold', id: 'th1', metric: 'cache_read_ratio', gte: 0.2 },
      ],
    }],
  }
  it('accepts valid rubric', () => {
    expect(() => rubricSchema.parse(valid)).not.toThrow()
  })
  it('rejects non-percent weight', () => {
    expect(() => rubricSchema.parse({ ...valid, sections: [{ ...valid.sections[0], weight: '0.5' }] })).toThrow()
  })
  it('rejects unknown signal type', () => {
    expect(() => rubricSchema.parse({ ...valid, sections: [{ ...valid.sections[0], signals: [{ type: 'weird', id: 'x' }] }] })).toThrow()
  })
})
```

- [ ] **Step 2: FAIL**.

- [ ] **Step 3: Implement** per design Section 5.1 (full Zod discriminated union over 9 signal types).

- [ ] **Step 4: PASS**.

- [ ] **Step 5: Commit** `feat(evaluator): rubric Zod schema + validator`

### Task 2.3: Signal collector — keyword + threshold

**Files:**
- Create: `packages/evaluator/src/signals/keyword.ts`
- Create: `packages/evaluator/src/signals/threshold.ts`
- Create: `packages/evaluator/src/signals/types.ts`
- Test: `packages/evaluator/tests/signals/keyword.test.ts`, `threshold.test.ts`

Keyword collector: takes `{ body: string, terms: string[], caseSensitive: boolean }` → returns `{ hits: number, evidence: Array<{quote, offset}> }`. Evidence extraction: ±80 chars context.

Threshold collector: takes `{ metric, gte?, lte?, between? }` + pre-computed `metricValue` → returns `{ hit: boolean }`.

Commit: `feat(evaluator): keyword + threshold signal collectors`

### Task 2.4: Signal collectors — domain-specific

**Files:**
- Create: `packages/evaluator/src/signals/refusalRate.ts`, `clientMix.ts`, `modelDiversity.ts`, `cacheReadRatio.ts`, `extendedThinking.ts`, `toolDiversity.ts`, `iterationCount.ts`
- Test: `packages/evaluator/tests/signals/*.test.ts`

Each signal takes a typed data slice (subset of `usage_logs` rows + `request_bodies` rows already decrypted upstream) and returns `{ hit: boolean, value, evidence? }`. Test per collector with fixture `{ input, expected }` pairs. At least 3 fixtures per collector (pass / fail / edge).

Commit: `feat(evaluator): domain-specific signal collectors (refusal/client/model/cache/thinking/tool/iteration)`

### Task 2.5: Metric aggregator (usage_logs + request_bodies → metrics)

**Files:**
- Create: `packages/evaluator/src/metrics/aggregator.ts`
- Test: `packages/evaluator/tests/metrics/aggregator.test.ts`

Pure function: `aggregate({ usageRows, bodyRows }) → Metrics`. Metrics shape is the frozen set listed in design §4.1 (requests, tokens, cost, cache_read_ratio, model_mix, client_mix, refusal_rate, body_capture_coverage). Fixtures with known input → expected metrics.

Commit: `feat(evaluator): metric aggregator (usage + body → summary)`

### Task 2.6: Rule-based scoring engine

**Files:**
- Create: `packages/evaluator/src/engine/ruleEngine.ts`
- Test: `packages/evaluator/tests/engine/ruleEngine.test.ts`

Top-level: `scoreWithRules({ rubric, usageRows, decryptedBodies }) → Report`. Composes collectors per section, applies `superiorRules` logic from rubric, clamps to [0,120], returns `{ totalScore, sectionScores, signalsSummary, dataQuality }`.

Port the `shouldScoreSuperior` + `shouldScoreGroupedSuperior` logic from CLI's `src/analyzers/section.ts` — adapted for the new signal types. Test with a full-rubric fixture (~3 sections, each with 2-3 signals).

Commit: `feat(evaluator): rule-based scoring engine (sections → total score)`

### Task 2.7: LLM prompt builder (snippet sampler)

**Files:**
- Create: `packages/evaluator/src/llm/promptBuilder.ts`, `snippetSampler.ts`
- Test: `packages/evaluator/tests/llm/snippetSampler.test.ts`, `promptBuilder.test.ts`

Snippet sampler: given decrypted bodies + rule-based result, pick up to 20 representative snippets (refusals, thinking-used, first/last per session, tool_use examples, random fill). Prompt builder: takes rubric + rule-based summary + snippets → returns `{ system, messages }` ready to send to Claude.

Commit: `feat(evaluator): LLM prompt builder + snippet sampler`

### Task 2.8: LLM response parser (JSON validation)

**Files:**
- Create: `packages/evaluator/src/llm/responseParser.ts`
- Test: `packages/evaluator/tests/llm/responseParser.test.ts`

Zod schema for LLM response: `{ narrative, evidence[], sectionAdjustments[] }`. Parser returns `{ ok: true, ...parsed } | { ok: false, error }`. Never throws — evaluator must survive malformed LLM output and fall back to rule-based only.

Commit: `feat(evaluator): LLM response parser with Zod validation`

---

## Part 3 — Body Capture Pipeline (apps/gateway)

Goal: Step 10a in the Plan 4A request pipeline — capture bodies when org has `contentCaptureEnabled`. Sanitize, truncate, encrypt, persist. Plus retention purge cron.

### Task 3.1: Sanitizer (mask secrets in request_params + tool input)

**Files:**
- Create: `apps/gateway/src/capture/sanitizer.ts`
- Test: `apps/gateway/tests/capture/sanitizer.test.ts`

Regex `/password|secret|token|api_key|bearer|cookie|authorization/i`. Walks JSON recursively, replaces matching-keyed string values with `"***"`. Keep structure intact. Idempotent.

Commit: `feat(gateway): body capture sanitizer (mask secret-keyed values)`

### Task 3.2: Body size cap + truncation

**Files:**
- Create: `apps/gateway/src/capture/truncate.ts`
- Test: `apps/gateway/tests/capture/truncate.test.ts`

Inputs: `{ requestBody, responseBody, thinkingBody?, attemptErrors, perToolResultCap: 16384, overallCap: 262144 }`. Output: `{ ...truncated, toolResultTruncated, bodyTruncated }`. Priority drop order: `attempt_errors > thinking_body > tool_result.content[].tail > response_body tail`.

Commit: `feat(gateway): body truncation (256KB overall cap + 16KB per-tool_result)`

### Task 3.3: Capture encryption (reuse @aide/gateway-core cipher)

**Files:**
- Create: `apps/gateway/src/capture/encrypt.ts`
- Test: `apps/gateway/tests/capture/encrypt.test.ts` (round-trip)

Uses `@aide/gateway-core`'s `encryptCredential` / `decryptCredential` with different `info`:

```ts
// Wrapper that sets info = "aide-gateway-body-v1", salt = requestId
function encryptBody({ masterKeyHex, requestId, plaintext }): Buffer  // nonce||ct||tag
function decryptBody({ masterKeyHex, requestId, sealed }): string
```

Commit: `feat(gateway): body encryption wrapper (HKDF domain "aide-gateway-body-v1")`

### Task 3.4: BullMQ body-capture queue + worker

**Files:**
- Create: `apps/gateway/src/workers/bodyCapture.ts`
- Test: `apps/gateway/tests/workers/bodyCapture.integration.test.ts` (testcontainers)

Queue: `aide:gw:body-capture`. Job payload: `{ requestId, orgId, userId, rawRequest, rawResponse, streamedTranscript, attemptErrors, rawThinking? }`. Worker: sanitize → truncate → gzip → encrypt → INSERT `request_bodies` (ON CONFLICT DO NOTHING). Idempotency via jobId=requestId. Concurrency 4, batch 100 / 1s flush.

Retention: compute `retentionUntil = now() + (org.retention_days_override ?? 90) days` at INSERT.

Commit: `feat(gateway): BullMQ body-capture worker with encryption + retention`

### Task 3.5: Wire Step 10a into request pipeline

**Files:**
- Modify: `apps/gateway/src/routes/messages.ts`, `chatCompletions.ts`
- Test: `apps/gateway/tests/routes/bodyCapture.integration.test.ts`

In both handler finishers (after Step 10 usage log enqueue): if `ctx.org.contentCaptureEnabled`, enqueue body-capture job. Non-blocking — if enqueue fails, emit `gw_body_capture_enqueued_total{result:"enqueue_failed"}` + warn log, continue returning to client.

Stream reconstruction: extend the stream translator's state machine to buffer the assembled transcript (concat text blocks + tool_use blocks as observed) and flush the buffer to capture queue on `message_stop`.

Commit: `feat(gateway): wire body capture into /v1/messages + /v1/chat/completions pipeline`

### Task 3.6: Retention purge cron

**Files:**
- Create: `apps/gateway/src/workers/bodyPurge.ts`
- Test: `apps/gateway/tests/workers/bodyPurge.integration.test.ts`

Every 4h: `DELETE FROM request_bodies WHERE retention_until <= now() LIMIT 10000` in a loop until 0 rows affected. Metrics: `gw_body_purge_deleted_total`, `gw_body_purge_duration_seconds`, `gw_body_purge_lag_hours`.

Commit: `feat(gateway): body retention purge cron (4h cadence)`

---

## Part 4 — Evaluator Cron + Rule-Based Execution

### Task 4.1: Evaluator BullMQ queue

**Files:**
- Create: `apps/gateway/src/workers/evaluator/queue.ts`
- Test: `apps/gateway/tests/workers/evaluator/queue.test.ts`

Queue `aide:gw:evaluator`. Job payload: `{ orgId, userId, periodStart, periodEnd, periodType, triggeredBy, triggeredByUser? }`. `attempts: 3, backoff: exponential, 1s`. Job id = `${userId}:${periodStart.toISOString()}:${periodType}` for idempotency.

Commit: `feat(gateway): BullMQ evaluator queue`

### Task 4.2: Rule-based evaluator worker

**Files:**
- Create: `apps/gateway/src/workers/evaluator/runRuleBased.ts`
- Test: `apps/gateway/tests/workers/evaluator/runRuleBased.integration.test.ts`

Job handler: fetch usage_logs in window → fetch + decrypt request_bodies → call `@aide/evaluator`'s `scoreWithRules` → upsert `evaluation_reports` row. Handles data_quality (empty window → skip with metric).

Commit: `feat(gateway): rule-based evaluator worker`

### Task 4.3: Daily cron scheduler

**Files:**
- Create: `apps/gateway/src/workers/evaluator/cron.ts`
- Test: `apps/gateway/tests/workers/evaluator/cron.integration.test.ts`

Every 00:05 UTC: for each org with `contentCaptureEnabled`, enumerate active users (members of org), enqueue jobs for `periodStart = yesterday UTC 00:00, periodEnd = today UTC 00:00, periodType = 'daily'`.

Commit: `feat(gateway): daily evaluator cron (00:05 UTC)`

### Task 4.4: Rubric resolver (org custom or platform default)

**Files:**
- Create: `apps/gateway/src/workers/evaluator/rubricResolver.ts`
- Test: `apps/gateway/tests/workers/evaluator/rubricResolver.test.ts`

Given `{ orgId, locale }`: if `org.rubric_id` set → load that rubric; else load platform default matching locale. Cache 5 min in-memory.

Commit: `feat(gateway): rubric resolver (org custom → platform default by locale)`

---

## Part 5 — LLM Deep Analysis

### Task 5.1: LLM dedicated api_key provisioning (one-time at org enable)

**Files:**
- Create: `apps/api/src/services/llmEvalKeyProvisioning.ts`
- Test: `apps/api/tests/services/llmEvalKey.integration.test.ts`

When `llm_eval_enabled` toggled on + `llm_eval_account_id` set, provision a dedicated internal api_key owned by a system user (`evaluator@<org>`) scoped to that org. Store key in Redis secret (`aide:gw:llm-eval-key:{orgId}`) — not exposed to UI.

Commit: `feat(api): provision dedicated api_key for LLM eval on toggle`

### Task 5.2: LLM runner (self-gateway POST /v1/messages)

**Files:**
- Create: `apps/gateway/src/workers/evaluator/runLlm.ts`
- Test: `apps/gateway/tests/workers/evaluator/runLlm.integration.test.ts` (fake-anthropic upstream)

Wrapper: `runLlmDeepAnalysis({ orgId, rubric, ruleBasedResult, decryptedBodies }) → { narrative, evidence, cost, model, adjustments }`. Calls `fetch(http://localhost:GATEWAY_PORT/v1/messages)` with the dedicated api_key. Parses response via `@aide/evaluator`'s `responseParser`. On any failure: return `null` (caller persists rule-based only).

Commit: `feat(gateway): LLM deep analysis runner (self-gateway call)`

### Task 5.3: LLM phase integration in evaluator worker

**Files:**
- Modify: `apps/gateway/src/workers/evaluator/runRuleBased.ts` → extract as `runEvaluation.ts` combining both phases
- Test: `apps/gateway/tests/workers/evaluator/runEvaluation.integration.test.ts`

Flow: rule-based → if `org.llm_eval_enabled` AND `data_quality.body_capture_coverage >= 0.5` → run LLM → merge narrative into report → upsert. Record `llm_called_at`, `llm_cost_usd`, `llm_upstream_account_id`, `llm_model`.

Commit: `feat(gateway): integrate LLM deep analysis into evaluator worker`

### Task 5.4: LLM failure metrics + DLQ handling

**Files:**
- Modify: `apps/gateway/src/workers/evaluator/runEvaluation.ts`
- Test: `apps/gateway/tests/workers/evaluator/runEvaluation.failures.test.ts`

Metrics: `gw_eval_llm_called_total`, `gw_eval_llm_cost_usd`, `gw_eval_llm_failed_total{reason}`, `gw_eval_llm_parse_failed_total`. BullMQ DLQ after 3 fails → `gw_eval_dlq_count`.

Commit: `feat(gateway): evaluator LLM failure metrics + DLQ`

---

## Part 6 — `apps/api` tRPC Routers

### Task 6.1: `contentCapture` router

**Files:**
- Create: `apps/api/src/trpc/routers/contentCapture.ts`
- Test: `apps/api/tests/integration/trpc/contentCapture.test.ts`

Endpoints: `getSettings(orgId)`, `setSettings(orgId, patch)` (toggle + retention + LLM + capture_thinking + leaderboard), `wipeExistingCaptures(orgId)` (sets `retention_until = now()` for all rows). RBAC: `content_capture.*`. On first-enable: audit log entry + write `contentCaptureEnabledAt / By`. Zod input validation.

Commit: `feat(api): tRPC contentCapture router`

### Task 6.2: `rubrics` router

**Files:**
- Create: `apps/api/src/trpc/routers/rubrics.ts`
- Test: `apps/api/tests/integration/trpc/rubrics.test.ts`

`list(orgId)`, `get(id)`, `create(orgId, definition)` (validates against `@aide/evaluator`'s `rubricSchema`), `update(rubricId, patch)`, `delete(rubricId)`, `setActive(orgId, rubricId)` (writes `organizations.rubric_id`), `dryRun(orgId, rubricId, days)` — pretends evaluate last N days without writing reports. RBAC: `rubric.*`.

Commit: `feat(api): tRPC rubrics router with dry-run`

### Task 6.3: `reports` router — read paths

**Files:**
- Create: `apps/api/src/trpc/routers/reports.ts` (read-only endpoints first)
- Test: `apps/api/tests/integration/trpc/reports.read.test.ts`

`getOwnLatest()`, `getOwnRange(from, to)`, `getUser(orgId, userId, range)`, `getTeam(orgId, teamId, range)`, `getOrg(orgId, range)`. All return shape: `{ report: EvaluationReport, llmNarrative?, llmEvidence? }` with `llm*` fields redacted if caller isn't org_admin or self. Scope enforcement via discriminated union (like usage router in Plan 4A).

Commit: `feat(api): tRPC reports router — read endpoints`

### Task 6.4: `reports` router — rerun / export / delete

**Files:**
- Modify: `apps/api/src/trpc/routers/reports.ts`
- Test: `apps/api/tests/integration/trpc/reports.mutations.test.ts`

`rerun({ orgId, scope, targetId, periodStart, periodEnd })` enqueues evaluator jobs. Window ≤ 30d enforced. `exportOwn()` — generates JSON dump `{ reports, decryptedBodies }` (decrypts in-process; streams if large). `deleteOwn({ scope: 'bodies' | 'bodies_and_reports', reason? })` — inserts `gdpr_delete_requests` row. `approveDelete(requestId)` / `rejectDelete(requestId, reason)` — admin.

Commit: `feat(api): tRPC reports rerun + export + GDPR delete workflow`

### Task 6.5: `evaluator` router (status only) + wire all 4 into appRouter

**Files:**
- Create: `apps/api/src/trpc/routers/evaluator.ts`
- Modify: `apps/api/src/trpc/router.ts`
- Test: `apps/api/tests/integration/trpc/router.test.ts` (extend with new namespaces)

`status(orgId)`: returns `{ lastCronAt, nextCronAt, queueDepth, dlqCount, coverageLastRun: { capturedRequests, totalRequests, reportsWritten } }`. Read-only.

Wire all 4 new routers (`contentCapture`, `rubrics`, `reports`, `evaluator`) into `appRouter`. Feature-flag guard: every endpoint throws `NOT_FOUND` when `ENABLE_EVALUATOR=false`.

Commit: `feat(api): evaluator status router + wire all 4 into appRouter`

---

## Part 7 — `apps/web` Admin UI

### Task 7.1: Evaluator settings page

**Files:**
- Create: `apps/web/src/app/dashboard/organizations/[id]/evaluator/settings/page.tsx`
- Create: `apps/web/src/components/evaluator/SettingsForm.tsx`

Master toggle, retention select (30/60/90), LLM section (toggle + account select + model + capture_thinking), rubric dropdown, leaderboard toggle, "Wipe existing captures" danger button. react-hook-form + zod. RequirePerm `content_capture.toggle`.

Commit: `feat(web): evaluator settings page`

### Task 7.2: Rubric management page

**Files:**
- Create: `apps/web/src/app/dashboard/organizations/[id]/evaluator/rubrics/page.tsx`
- Create: `apps/web/src/components/evaluator/RubricList.tsx`, `RubricEditor.tsx`

List platform defaults (read-only) + org custom (editable). "Create new" form uploads JSON or fills in wizard. "Dry run last 7 days" button → calls `rubrics.dryRun`, displays preview card. Zod validation client-side before submit.

Commit: `feat(web): rubric management + dry-run preview`

### Task 7.3: Evaluator status page

**Files:**
- Create: `apps/web/src/app/dashboard/organizations/[id]/evaluator/status/page.tsx`
- Create: `apps/web/src/components/evaluator/StatusCard.tsx`

Last cron run, next scheduled, queue depth, DLQ count, coverage (N of M members). Refresh button. RequirePerm `evaluator.read_status`.

Commit: `feat(web): evaluator status page`

### Task 7.4: Member detail with report

**Files:**
- Modify/Create: `apps/web/src/app/dashboard/organizations/[id]/members/[uid]/page.tsx`
- Create: `apps/web/src/components/evaluator/ReportDetail.tsx`, `TrendChart.tsx`

30-day line chart (SVG, consistent with Plan 4A `UsageChart`). Section scores table with evidence drill-down (expand row → shows evidence quotes + request_ids). LLM narrative card (if present). "Rerun this period" button (org_admin only).

Commit: `feat(web): member detail with report + 30-day trend + evidence drill-down`

### Task 7.5: Team view with aggregate + optional leaderboard

**Files:**
- Modify: `apps/web/src/app/dashboard/organizations/[id]/teams/[tid]/page.tsx`
- Create: `apps/web/src/components/evaluator/TeamAggregate.tsx`, `TeamLeaderboard.tsx`

Team average score + trend. Member list with scores (ranked if `leaderboardEnabled`, otherwise alphabetical). Leaderboard visibility: team_manager + team members.

Commit: `feat(web): team evaluator aggregate + optional leaderboard`

### Task 7.6: Org list extension (latest score column)

**Files:**
- Modify: `apps/web/src/app/dashboard/organizations/[id]/members/page.tsx`
- Create: `apps/web/src/components/evaluator/MemberScoreCell.tsx`

Add "Latest score" column to members table. Shows last daily report score, color-coded (< 80 amber, ≥ 80 emerald, ≥ 100 sky). RequirePerm `report.read_org`.

Commit: `feat(web): latest score column on org members table`

---

## Part 8 — `apps/web` Member UI

### Task 8.1: Profile evaluation page

**Files:**
- Create: `apps/web/src/app/dashboard/profile/evaluation/page.tsx`
- Create: `apps/web/src/components/evaluator/ProfileEvaluation.tsx`, `ProfileBanner.tsx`

Top banner: consent disclosure (retention, admin contact). 30-day trend chart (own only). Latest report detail — all sections, all evidence, LLM narrative. "Export my data" button. "Request deletion" button.

Commit: `feat(web): profile evaluation page`

### Task 8.2: Data export UI

**Files:**
- Create: `apps/web/src/components/evaluator/ExportDialog.tsx`

Modal: explain what's being exported (reports + decrypted bodies for period), warns about file size, click → calls `reports.exportOwn`, downloads JSON. Streamed download for large exports.

Commit: `feat(web): profile data export dialog`

### Task 8.3: GDPR delete request UI

**Files:**
- Create: `apps/web/src/components/evaluator/DeleteRequestDialog.tsx`

Modal: scope radio (`bodies` / `bodies_and_reports`), reason textarea, submit → calls `reports.deleteOwn`. Shows pending-approval state afterwards with "your org admin will review" message.

Commit: `feat(web): GDPR delete request dialog`

### Task 8.4: Banner on profile + sign-in handoff

**Files:**
- Modify: `apps/web/src/app/dashboard/profile/page.tsx`

Conditional banner at top of profile: if `contentCaptureEnabled`, show "Evaluation is enabled. View your reports →" linking to `/profile/evaluation`. Link must be clearly visible but not intrusive.

Commit: `feat(web): profile capture-enabled banner with link to evaluation`

---

## Part 9 — Platform-Default Rubrics

### Task 9.1: Port CLI `templates/eval-standard.json` → platform-default (en)

**Files:**
- Create: `packages/evaluator/rubrics/platform-default.en.json`
- Test: `packages/evaluator/tests/rubrics/platform-default.en.test.ts`

Take CLI's 2-section rubric, remap signals:
- CLI `ConversationSignal` keyword → gateway `keyword` on `request_body` or `both`
- CLI facet-based rules → drop or replace with gateway equivalents (e.g. `client_mix` for tool identification, `refusal_rate` for friction proxy)
- Keep section ids stable (`interaction`, `risk`) for continuity

Validate against `rubricSchema`. Test that score goes to 120 on a fixture hitting all superior signals.

Commit: `feat(evaluator): platform-default rubric (en)`

### Task 9.2: Translate platform-default to zh-Hant + ja

**Files:**
- Create: `packages/evaluator/rubrics/platform-default.zh-hant.json`, `.ja.json`
- Test: extend `platform-default.*.test.ts` to cover all 3 locales

Same `sections[].id`s, translated `name` / `description` / `criteria`. Keywords translated (careful: keep both English and Chinese variants for mixed-language prompts).

Commit: `feat(evaluator): platform-default rubric (zh-Hant + ja)`

### Task 9.3: Seed platform-default rubrics via migration

**Files:**
- Create: `packages/db/drizzle/0003_seed_platform_rubrics.sql`
- Test: `packages/db/tests/schema/migration0003.test.ts`

Hand-written migration that `INSERT`s the 3 JSON files into `rubrics` with `org_id = NULL, is_default = true, version = '1.0.0'`. Use `jsonb` literals or `\copy` depending on drizzle-kit limits. If drizzle-kit can't handle, write as raw SQL.

Commit: `feat(db): seed 3 platform-default rubrics (en, zh-Hant, ja)`

---

## Part 10 — GDPR Delete Worker

### Task 10.1: Delete worker (consumes approved `gdpr_delete_requests`)

**Files:**
- Create: `apps/gateway/src/workers/gdprDelete.ts`
- Test: `apps/gateway/tests/workers/gdprDelete.integration.test.ts`

Runs every 5 min: `SELECT * FROM gdpr_delete_requests WHERE approved_at IS NOT NULL AND executed_at IS NULL`. For each: DELETE from `request_bodies`. If `scope = 'bodies_and_reports'`: also DELETE from `evaluation_reports`. Set `executed_at = now()`. Audit log.

Commit: `feat(gateway): GDPR delete worker (5-min cadence)`

### Task 10.2: Notification on delete request (email or log)

**Files:**
- Create: `apps/api/src/services/gdprNotifications.ts`
- Test: `apps/api/tests/services/gdprNotifications.test.ts`

On `gdpr_delete_requests` INSERT, emit structured log `gdpr_delete_requested` + write to an internal org admin audit queue (via `audit_logs` table from Plan 2). No external email in 4B — just log + audit. Email integration is Plan 4D.

Commit: `feat(api): GDPR delete request notifications (log + audit)`

### Task 10.3: Auto-reject expired requests

**Files:**
- Create: `apps/gateway/src/workers/gdprExpire.ts`
- Test: `apps/gateway/tests/workers/gdprExpire.integration.test.ts`

Daily cron: find requests `WHERE approved_at IS NULL AND rejected_at IS NULL AND requested_at < now() - '30 days'` → set `rejected_at = now()`, `rejected_reason = 'auto-rejected: unresponsive beyond 30 days'`. Member must re-request. Metric `gw_gdpr_auto_rejected_total`.

Commit: `feat(gateway): GDPR auto-reject stale requests (30-day SLA)`

---

## Part 11 — CI + E2E

### Task 11.1: CI `evaluator-integration` job

**Files:**
- Modify: `.github/workflows/ci.yml`

Add job that runs `pnpm -F @aide/evaluator test`, `pnpm -F @aide/api test:integration --testPathPattern=evaluator`, `pnpm -F @aide/gateway test:integration --testPathPattern=(bodyCapture|evaluator|gdpr)`. testcontainers Postgres + Redis as the existing `gateway-integration` job.

Commit: `ci: add evaluator-integration job`

### Task 11.2: E2E smoke — admin enables capture → member request → report appears

**Files:**
- Create: `apps/web/e2e/specs/20-evaluator-happy.spec.ts`

Playwright: super_admin signs in → creates org → enables content capture → provisions upstream account → issues api_key → simulates `/v1/messages` call → triggers daily cron via admin rerun → reads report on member profile. Uses fake-anthropic-server for upstream.

Commit: `test(e2e): evaluator happy-path smoke`

### Task 11.3: `scripts/smoke-evaluator.sh`

**Files:**
- Create: `scripts/smoke-evaluator.sh`

Curl sequence: enable capture via admin tRPC → POST `/v1/messages` → wait 5s → rerun today → assert `evaluation_reports` row exists via tRPC read. Mirrors `scripts/smoke-gateway.sh` pattern.

Commit: `test(smoke): evaluator post-deploy verification script`

---

## Part 12 — Documentation

### Task 12.1: `docs/EVALUATOR.md` + extend `docs/GATEWAY.md`

**Files:**
- Create: `docs/EVALUATOR.md`
- Modify: `docs/GATEWAY.md`

EVALUATOR.md covers: what it is, capture opt-in process, rubric customization, LLM Deep Analysis enable path, member transparency flow, GDPR export/delete, runbook (from design §7.4). GATEWAY.md gets a new "Body capture (Plan 4B)" section linking forward.

Commit: `docs: EVALUATOR.md + GATEWAY.md body-capture section`

### Task 12.2: Update `SELF_HOSTING.md` + env docs

**Files:**
- Modify: `docs/SELF_HOSTING.md`, `docker/.env.example`

SELF_HOSTING: new section "Enabling the evaluator (Plan 4B+)". `.env.example`: add `ENABLE_EVALUATOR=false` + comment documenting that retention and LLM eval are org-level UI settings, not env.

Commit: `docs: SELF_HOSTING + .env.example for evaluator`

---

## Part 13 — Feature Flag Rollout Playbook

### Task 13.1: Manual acceptance runbook + env flag wire-up

**Files:**
- Create: `docs/runbooks/evaluator-rollout.md`
- Modify: `packages/config/src/env.ts` → add `ENABLE_EVALUATOR`
- Modify: `apps/gateway/src/server.ts` + `apps/api/src/server.ts` → conditional worker/route registration on flag

Runbook: 5-step playbook for enabling evaluator on a live deployment (pull v0.4.0 → set flag → migrate → verify cron registered → enable on first pilot org).

Commit: `feat(config,gateway,api): ENABLE_EVALUATOR feature flag + rollout runbook`

---

## Part 14 — v0.4.0 Tag

### Task 14.1: README + CHANGELOG + tag v0.4.0

**Files:**
- Modify: `README.md` (add Plan 4B feature bullets under Platform mode)
- Modify: `CHANGELOG.md`

Steps:

- [ ] Update README section on Platform mode to include content capture + evaluator
- [ ] Write CHANGELOG entry `## v0.4.0 — YYYY-MM-DD — Plan 4B evaluator shipped` (enumerate 14 design decisions)
- [ ] Verify `pnpm turbo run lint typecheck test build` green
- [ ] Manual smoke: `scripts/smoke-evaluator.sh` on staging
- [ ] Tag + push:

```bash
git tag -a v0.4.0 -m "Plan 4B — evaluator"
git push origin v0.4.0
```

Release workflow produces multi-arch `aide-{api,web,gateway}:v0.4.0`. Write GitHub release notes mirroring v0.3.0 format.

Commit: `docs: README + CHANGELOG for v0.4.0 — Plan 4B evaluator`

---

## Self-Review Checklist (before dispatch)

- [x] Every task has explicit file paths (Create / Modify / Test)
- [x] 5-step TDD rhythm (test → fail → impl → pass → commit) on code tasks; compact description for mechanical commits
- [x] Commit messages follow `type(scope): subject`
- [x] No placeholder strings (TBD/TODO/fill in)
- [x] Types from early tasks (`SealedBody`, `Rubric`, `Report`) are consistent across later tasks
- [x] Feature flag `ENABLE_EVALUATOR` gated at 4 layers per design §8.1
- [x] Encryption reuses `CREDENTIAL_ENCRYPTION_KEY` with different `info` — no new secret required

## Pause Points for User Checkpoints

- After **Part 2** — `packages/evaluator` pure logic done, unit tests ≥ 90% coverage
- After **Part 5** — full evaluator runs end-to-end against fake-anthropic (rule-based + LLM)
- After **Part 7** — admin UI visible in browser
- Before **Part 14** — final smoke before tag

## Execution Handoff

Use `superpowers:subagent-driven-development` to execute. Two-stage review after each task: spec compliance then code quality. Dispatch one implementer subagent per task; parallelize reviews with next implementation per Plan 4A's established rhythm.

*End of Plan 4B implementation plan.*


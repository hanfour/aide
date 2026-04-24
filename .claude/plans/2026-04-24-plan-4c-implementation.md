# Plan 4C Implementation Plan — Operations Hardening + LLM Facet Enrichment (v0.5.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the v0.4.0 evaluator production-safe (observability, cost control, alerts) and restore CLI-parity signals (`bugsCaught`, `frictionSessions`, `codexErrorSessions`) via LLM facet extraction. Ship as v0.5.0.

**Architecture:** Layered roll-out. Phase 1 (Theme A) ships cost-budget infra, Grafana dashboards, alert rules, runbooks, post-release smoke, SSE integration test, web-image arm64 removal. Phase 2 (Theme B) builds on Phase 1's cost enforcement: adds `request_body_facets` table, lazy facet extractor in evaluator worker, 6 new facet_* signals, null-aware rubric weight redistribution, and platform rubric v2. Feature flag `ENABLE_FACET_EXTRACTION=false` gates Phase 2 until self-org canary validates.

**Tech Stack:** TypeScript (monorepo: apps/api, apps/gateway, apps/web, packages/evaluator, packages/auth), PostgreSQL (migrations via node-pg-migrate), BullMQ (Redis), Vitest + Playwright, Prometheus + Grafana + Alertmanager, Next.js App Router, tRPC, Zod, MSW.

**Spec:** `.claude/plans/2026-04-24-plan-4c-design.md`
**Handoff:** `.claude/plans/2026-04-24-plan-4c-handoff.md`

---

## Codebase conventions (MUST read before implementing any task)

This plan was initially drafted against generic Node.js assumptions; the codebase actually follows these conventions. **When a task body's code samples conflict with these conventions, follow the conventions.**

### Database (Drizzle ORM)

- **Schema source:** `packages/db/src/schema/*.ts` (TypeScript). Export barrel: `packages/db/src/schema/index.ts`.
- **Migrations:** auto-generated via `pnpm --filter @aide/db db:generate` → files land in `packages/db/drizzle/NNNN_*.sql` (never hand-written up migrations).
- **Applying migrations:** `pnpm --filter @aide/db db:migrate` (requires `DATABASE_URL`).
- **Down migrations:** not native. Hand-write `packages/db/drizzle/NNNN_down.sql` (with `_down` suffix so drizzle runner ignores it); apply manually with `psql -f`. Also requires editing `packages/db/drizzle/meta/_journal.json` to drop the entry.
- **Enum-like columns:** prefer `text` + Zod runtime validation over `pgEnum` (see `evaluationReports.triggeredBy`, `evaluationReports.periodType`).

### RBAC (code-based, not DB-backed)

- **No `rbac_actions` table.** Permissions are a TypeScript discriminated union in `packages/auth/src/rbac/actions.ts`.
- Add a new action by extending the `Action` union and mapping it to roles in `packages/auth/src/rbac/check.ts`.
- Call via `can(ctx.perm, { type: "…", orgId })` in tRPC procedures.

### Existing tRPC structure

- App router at `apps/api/src/trpc/router.ts` already registers `evaluator: evaluatorRouter`.
- Evaluator router at `apps/api/src/trpc/routers/evaluator.ts` — **extend this file** with new procedures (e.g. `costSummary`). Do NOT create a new `evaluatorCost.ts` sibling.
- Procedure builder: `evaluatorProcedure` from `./_evaluatorGate.js` (wraps org-level feature-flag gating).

### Test helpers (existing)

- **DB:** `setupTestDb()` from `apps/api/tests/factories/db.ts` — returns `{ db, pool, container, url, stop() }`. `db` is a Drizzle instance; `pool` is the raw pg Pool. Applies all migrations up to HEAD. Start via Testcontainers, so slow (~5-10s) — use `beforeAll`/`afterAll`, not per-test.
- **Org/Dept/Team:** `makeOrg(db, overrides)`, `makeDept(db, orgId, overrides)`, `makeTeam(db, orgId, overrides)` in `apps/api/tests/factories/org.ts`. Overrides use **camelCase field names** (`llmEvalEnabled`, `llmMonthlyBudgetUsd`), not snake_case.
- **User:** `makeUser(db, opts)` in `apps/api/tests/factories/user.ts`.
- **tRPC caller:** `callerFor(...)` and `anonCaller(...)` in `apps/api/tests/factories/caller.ts`.
- **Raw SQL in tests:** use `testDb.db.execute(sql\`…\`)` (Drizzle) or `testDb.pool.query('…')` (pg Pool). Parameterize via Drizzle's `${value}` template interpolation.
- `makeMember`, `seedMember`, `seedRequestBody` **do not exist** — add them in a factory file or inline SQL via `testDb.db.execute`.

### Migration commands (reference)

Wherever this plan says `pnpm --filter @aide/api migrate:up` or `migrate:down`, replace with:
- **Up:** `pnpm --filter @aide/db db:migrate`
- **Down:** `psql $DATABASE_URL -f packages/db/drizzle/NNNN_down.sql` (emergency only)
- **Generate:** `pnpm --filter @aide/db db:generate`
- **Integration test running:** `pnpm --filter @aide/api test:integration` (Testcontainer-backed), **not** `test`.

### Column naming (Drizzle → SQL)

- Drizzle column names use camelCase in TypeScript, snake_case in SQL (e.g. `llmFacetEnabled` field → `llm_facet_enabled` column).
- Raw SQL in tests must use snake_case. TypeScript imports / Drizzle queries use camelCase.

### Worktree

- Worktree: `/Users/hanfourhuang/ai-dev-eval/.worktrees/plan-4c-phase-1`
- Branch: `feat/plan-4c-phase-1`
- Baseline: 639 tests passing.

---

## Plan structure

**Phase 1 (Theme A — Operations Hardening):** Parts 1-12
**Phase 2 (Theme B — LLM Facet Enrichment):** Parts 13-18

Commits use conventional format: `feat:` / `fix:` / `docs:` / `test:` / `chore:` / `ci:`.

---

## Part 1 — Schema migration 0004 (cost budget infrastructure)

> **Codebase conventions (applies to all migration parts):** this project uses Drizzle ORM. Schema lives at `packages/db/src/schema/*.ts`. SQL migrations are **generated** via `pnpm --filter @aide/db db:generate`, producing numbered files in `packages/db/drizzle/NNNN_*.sql`. Apply with `pnpm --filter @aide/db db:migrate`. Drizzle has no built-in down migrations; we hand-write `*.down.sql` files alongside the generated up migrations for emergency rollback (not auto-applied by tooling). Test DB via `setupTestDb()` from `apps/api/tests/factories/db.ts` (Testcontainers).

### Task 1.1: Add schema columns + new llmUsageEvents table (generate migration 0004)

**Files:**
- Modify: `packages/db/src/schema/org.ts`
- Create: `packages/db/src/schema/llmUsageEvents.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generated: `packages/db/drizzle/0004_<auto>.sql`

- [ ] **Step 1: Modify `packages/db/src/schema/org.ts`**

Append to the `organizations` pgTable definition (inside the column object, before the closing brace):

```typescript
  // Plan 4C — cost budget + facet
  llmFacetEnabled: boolean("llm_facet_enabled").notNull().default(false),
  llmFacetModel: text("llm_facet_model"),
  llmMonthlyBudgetUsd: decimal("llm_monthly_budget_usd", { precision: 10, scale: 2 }),
  llmBudgetOverageBehavior: text("llm_budget_overage_behavior").notNull().default("degrade"),
  llmHaltedUntilMonthEnd: boolean("llm_halted_until_month_end").notNull().default(false),
```

Add `decimal` to the imports at the top of the file:
```typescript
import { pgTable, text, timestamp, uuid, unique, boolean, integer, decimal, type AnyPgColumn } from "drizzle-orm/pg-core";
```

Note: `llm_budget_overage_behavior` uses `text` + runtime Zod validation (degrade/halt) instead of `pgEnum` to avoid a migration when future values are added.

- [ ] **Step 2: Create `packages/db/src/schema/llmUsageEvents.ts`**

```typescript
// packages/db/src/schema/llmUsageEvents.ts
import { pgTable, uuid, text, integer, decimal, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./org.js";

export const llmUsageEvents = pgTable("llm_usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),   // 'facet_extraction' | 'deep_analysis'
  model: text("model").notNull(),
  tokensInput: integer("tokens_input").notNull(),
  tokensOutput: integer("tokens_output").notNull(),
  costUsd: decimal("cost_usd", { precision: 10, scale: 6 }).notNull(),
  refType: text("ref_type"),                  // 'request_body_facet' | 'evaluation_report' | null
  refId: uuid("ref_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgMonthIdx: index("llm_usage_org_month_idx").on(t.orgId, t.createdAt),
}));
```

Note: enum-like columns (`eventType`, `refType`, `llmBudgetOverageBehavior`) use plain `text` with Zod runtime validation at the application layer. Matches project convention (see `evaluationReports.triggeredBy`, `evaluationReports.periodType`).

- [ ] **Step 3: Export from `packages/db/src/schema/index.ts`**

Append:

```typescript
export * from "./llmUsageEvents.js";
```

- [ ] **Step 4: Generate migration**

Run from repo root:

```bash
pnpm --filter @aide/db db:generate
```

Expected: a new file `packages/db/drizzle/0004_<random_name>.sql` is created. Inspect it:

```bash
cat packages/db/drizzle/0004_*.sql
```

Expected contents should include:
- `ALTER TABLE "organizations" ADD COLUMN "llm_facet_enabled" …` (× 5 new columns)
- `CREATE TABLE "llm_usage_events" ( … )` with all columns
- `CREATE INDEX "llm_usage_org_month_idx" ON …`

If the generated SQL looks wrong, edit the schema files and re-generate (delete the generated 0004 file first).

- [ ] **Step 5: Apply migration to a throw-away local DB**

Start a local Postgres (e.g. `docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=aide_dev -e POSTGRES_USER=aide -e POSTGRES_DB=aide_test postgres:16-alpine`).

```bash
DATABASE_URL=postgresql://aide:aide_dev@localhost:5432/aide_test pnpm --filter @aide/db db:migrate
```

Expected: `Migrations complete.`

- [ ] **Step 6: Verify schema via psql**

```bash
psql $DATABASE_URL -c "\d organizations" | grep llm_facet_enabled
```
Expected: `llm_facet_enabled | boolean | not null default false`

```bash
psql $DATABASE_URL -c "\d llm_usage_events"
```
Expected: 10 columns, PK on `id`, index `llm_usage_org_month_idx`.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/org.ts packages/db/src/schema/llmUsageEvents.ts packages/db/src/schema/index.ts packages/db/drizzle/0004_*.sql packages/db/drizzle/meta/
git commit -m "feat(db): migration 0004 cost budget infra (organizations cols + llm_usage_events)"
```

### Task 1.2: Add RBAC action type `evaluator.view_cost`

**Files:**
- Modify: `packages/auth/src/rbac/actions.ts`
- Modify: `packages/auth/src/rbac/check.ts` (or wherever role-to-action mapping lives)

- [ ] **Step 1: Inspect existing pattern**

Run:

```bash
grep -n "evaluator.read_status" packages/auth/src/rbac/*.ts
```

This shows how `evaluator.read_status` is defined and mapped to roles. Follow the same pattern.

- [ ] **Step 2: Add new action type to `actions.ts`**

In the `Action` union type, add (alongside `evaluator.read_status`):

```typescript
  | { type: "evaluator.view_cost"; orgId: string }
```

- [ ] **Step 3: Map to super_admin + org_admin in `check.ts`**

Locate where `evaluator.read_status` is granted. Add `evaluator.view_cost` with the same role mapping (super_admin and org_admin can view cost for any org in their scope; org_admin limited to their own org).

- [ ] **Step 4: Write unit test**

Create or append to `packages/auth/tests/unit/rbac/evaluator-actions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { can } from "../../../src/rbac/check";

describe("RBAC: evaluator.view_cost", () => {
  const orgId = "00000000-0000-0000-0000-000000000001";

  it("org_admin of the same org can view cost", () => {
    const perm = { roles: [{ role: "org_admin", scopeType: "organization", scopeId: orgId }] };
    expect(can(perm as any, { type: "evaluator.view_cost", orgId })).toBe(true);
  });

  it("org_admin of a different org cannot view cost", () => {
    const perm = { roles: [{ role: "org_admin", scopeType: "organization", scopeId: "other-org" }] };
    expect(can(perm as any, { type: "evaluator.view_cost", orgId })).toBe(false);
  });

  it("super_admin can view any org's cost", () => {
    const perm = { roles: [{ role: "super_admin", scopeType: "global", scopeId: null }] };
    expect(can(perm as any, { type: "evaluator.view_cost", orgId })).toBe(true);
  });

  it("member cannot view cost", () => {
    const perm = { roles: [{ role: "member", scopeType: "organization", scopeId: orgId }] };
    expect(can(perm as any, { type: "evaluator.view_cost", orgId })).toBe(false);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @aide/auth test rbac/evaluator-actions`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/auth/src/rbac/actions.ts packages/auth/src/rbac/check.ts packages/auth/tests/unit/rbac/evaluator-actions.test.ts
git commit -m "feat(auth): add evaluator.view_cost RBAC action"
```

### Task 1.3: Hand-write down migration for emergency rollback

**Files:**
- Create: `packages/db/drizzle/0004_down.sql` (naming suffix: `_down.sql` to avoid drizzle auto-picking it up)

- [ ] **Step 1: Write down SQL**

```sql
-- packages/db/drizzle/0004_down.sql
-- EMERGENCY ROLLBACK ONLY. Not auto-applied by drizzle migrator.
-- Run manually with: psql $DATABASE_URL -f packages/db/drizzle/0004_down.sql

BEGIN;

DROP INDEX IF EXISTS "llm_usage_org_month_idx";
DROP TABLE IF EXISTS "llm_usage_events";

ALTER TABLE "organizations"
  DROP COLUMN IF EXISTS "llm_halted_until_month_end",
  DROP COLUMN IF EXISTS "llm_budget_overage_behavior",
  DROP COLUMN IF EXISTS "llm_monthly_budget_usd",
  DROP COLUMN IF EXISTS "llm_facet_model",
  DROP COLUMN IF EXISTS "llm_facet_enabled";

-- NOTE: drizzle's migration journal in drizzle/meta/ must be manually edited
-- to remove the 0004 entry after running this. See packages/db/drizzle/meta/_journal.json.

COMMIT;
```

- [ ] **Step 2: Verify file is ignored by drizzle runner**

Run: `pnpm --filter @aide/db db:migrate` (on a DB that's already at 0004)
Expected: `No migrations to apply` (drizzle only picks up files matching `NNNN_*.sql`, not `NNNN_down.sql`).

- [ ] **Step 3: Commit**

```bash
git add packages/db/drizzle/0004_down.sql
git commit -m "chore(db): hand-written down SQL for migration 0004 (emergency only)"
```

### Task 1.4: Migration 0004 integration test

**Files:**
- Create: `apps/api/tests/integration/migrations/0004.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// apps/api/tests/integration/migrations/0004.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb, type TestDb } from "../../factories/db";
import { sql } from "drizzle-orm";
import { makeOrg } from "../../factories/org";

describe("migration 0004 cost infra", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();  // applies all migrations up to HEAD, including 0004
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("adds cost columns to organizations", async () => {
    const rows = await testDb.db.execute<{ column_name: string; is_nullable: string; column_default: string | null }>(
      sql`
        SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name='organizations'
          AND column_name IN (
            'llm_facet_enabled', 'llm_facet_model', 'llm_monthly_budget_usd',
            'llm_budget_overage_behavior', 'llm_halted_until_month_end'
          )
        ORDER BY column_name
      `
    );
    expect(rows.rows.length).toBe(5);
    const byName = Object.fromEntries(rows.rows.map(r => [r.column_name, r]));
    expect(byName.llm_facet_enabled.is_nullable).toBe("NO");
    expect(byName.llm_facet_enabled.column_default).toBe("false");
    expect(byName.llm_monthly_budget_usd.is_nullable).toBe("YES");
    expect(byName.llm_budget_overage_behavior.column_default).toContain("degrade");
  });

  it("creates llm_usage_events table with expected columns", async () => {
    const rows = await testDb.db.execute<{ column_name: string }>(
      sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='llm_usage_events'
        ORDER BY ordinal_position
      `
    );
    expect(rows.rows.map(r => r.column_name)).toEqual([
      "id","org_id","event_type","model","tokens_input","tokens_output",
      "cost_usd","ref_type","ref_id","created_at",
    ]);
  });

  it("can insert and query llm_usage_events rows", async () => {
    const org = await makeOrg(testDb.db);
    await testDb.db.execute(sql`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd)
      VALUES (${org.id}, 'facet_extraction', 'claude-haiku-4-5', 100, 50, 0.0002)
    `);
    const rows = await testDb.db.execute<{ count: string }>(
      sql`SELECT COUNT(*) as count FROM llm_usage_events WHERE org_id = ${org.id}`
    );
    expect(rows.rows[0].count).toBe("1");
  });

  it("cascades delete from organizations to llm_usage_events", async () => {
    const org = await makeOrg(testDb.db);
    await testDb.db.execute(sql`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd)
      VALUES (${org.id}, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 0.001)
    `);
    await testDb.db.execute(sql`DELETE FROM organizations WHERE id = ${org.id}`);
    const rows = await testDb.db.execute<{ count: string }>(
      sql`SELECT COUNT(*) as count FROM llm_usage_events WHERE org_id = ${org.id}`
    );
    expect(rows.rows[0].count).toBe("0");
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter @aide/api test:integration integration/migrations/0004`
Expected: 4 tests pass.

Note: this project uses `test:integration` script (not `test`) to run Testcontainer-backed integration tests — see `apps/api/package.json`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/integration/migrations/0004.test.ts
git commit -m "test(db): migration 0004 integration test (columns, table, cascade)"
```

---

## Part 2 — Pricing table + cost-aware LLM wrapper

### Task 2.1: Pricing table with calculateCost

**Files:**
- Create: `packages/evaluator/src/llm/pricing.ts`
- Test: `packages/evaluator/tests/llm/pricing.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/evaluator/tests/llm/pricing.test.ts
import { describe, it, expect } from 'vitest';
import { PRICING, calculateCost } from '../../src/llm/pricing';

describe('calculateCost', () => {
  it('computes haiku cost correctly', () => {
    // haiku: $0.80/MTok input, $4/MTok output
    // 1M input + 1M output = $0.80 + $4.00 = $4.80
    expect(calculateCost('claude-haiku-4-5', 1_000_000, 1_000_000)).toBeCloseTo(4.80, 6);
  });

  it('computes sonnet cost correctly', () => {
    expect(calculateCost('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18.00, 6);
  });

  it('computes opus cost correctly', () => {
    expect(calculateCost('claude-opus-4-7', 1_000_000, 1_000_000)).toBeCloseTo(90.00, 6);
  });

  it('scales linearly for smaller token counts', () => {
    expect(calculateCost('claude-haiku-4-5', 1000, 1000)).toBeCloseTo(0.0048, 6);
  });

  it('returns 0 for 0 tokens', () => {
    expect(calculateCost('claude-haiku-4-5', 0, 0)).toBe(0);
  });

  it('handles input-only calls', () => {
    expect(calculateCost('claude-haiku-4-5', 1_000_000, 0)).toBeCloseTo(0.80, 6);
  });

  it('throws for unknown model', () => {
    expect(() => calculateCost('gpt-4', 100, 100)).toThrow(/Unknown model for pricing: gpt-4/);
  });

  it('exposes PRICING map with all 3 Claude models', () => {
    expect(Object.keys(PRICING).sort()).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/evaluator test llm/pricing`
Expected: FAIL (module not found)

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/evaluator/src/llm/pricing.ts
export interface ModelPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7':   { inputUsdPerMTok: 15,   outputUsdPerMTok: 75 },
  'claude-sonnet-4-6': { inputUsdPerMTok: 3,    outputUsdPerMTok: 15 },
  'claude-haiku-4-5':  { inputUsdPerMTok: 0.80, outputUsdPerMTok: 4 },
};

export function calculateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = PRICING[model];
  if (!p) throw new Error(`Unknown model for pricing: ${model}`);
  return (tokensIn * p.inputUsdPerMTok / 1_000_000)
       + (tokensOut * p.outputUsdPerMTok / 1_000_000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/evaluator test llm/pricing`
Expected: 8 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/llm/pricing.ts packages/evaluator/tests/llm/pricing.test.ts
git commit -m "feat(evaluator): pricing table + calculateCost for 3 Claude models"
```

### Task 2.2: Budget error types

**Files:**
- Create: `packages/evaluator/src/budget/errors.ts`
- Test: `packages/evaluator/tests/budget/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/evaluator/tests/budget/errors.test.ts
import { describe, it, expect } from 'vitest';
import {
  BudgetExceededDegrade,
  BudgetExceededHalt,
  isBudgetError,
} from '../../src/budget/errors';

describe('budget errors', () => {
  it('BudgetExceededDegrade carries orgId and estimatedCost', () => {
    const e = new BudgetExceededDegrade({ orgId: 'org-1', estimatedCost: 0.05, currentSpend: 49.99, budget: 50 });
    expect(e.name).toBe('BudgetExceededDegrade');
    expect(e.orgId).toBe('org-1');
    expect(e.estimatedCost).toBe(0.05);
    expect(e.currentSpend).toBe(49.99);
    expect(e.budget).toBe(50);
  });

  it('BudgetExceededHalt is distinguishable from Degrade', () => {
    const h = new BudgetExceededHalt({ orgId: 'org-2', estimatedCost: 1, currentSpend: 50, budget: 50 });
    expect(h).toBeInstanceOf(BudgetExceededHalt);
    expect(h).not.toBeInstanceOf(BudgetExceededDegrade);
  });

  it('isBudgetError identifies both types', () => {
    expect(isBudgetError(new BudgetExceededDegrade({ orgId: 'a', estimatedCost: 1, currentSpend: 1, budget: 1 }))).toBe(true);
    expect(isBudgetError(new BudgetExceededHalt({ orgId: 'a', estimatedCost: 1, currentSpend: 1, budget: 1 }))).toBe(true);
    expect(isBudgetError(new Error('other'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/evaluator test budget/errors`
Expected: FAIL (module not found)

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/evaluator/src/budget/errors.ts
export interface BudgetErrorContext {
  orgId: string;
  estimatedCost: number;
  currentSpend: number;
  budget: number;
}

export class BudgetExceededDegrade extends Error {
  readonly orgId: string;
  readonly estimatedCost: number;
  readonly currentSpend: number;
  readonly budget: number;

  constructor(ctx: BudgetErrorContext) {
    super(`Budget would be exceeded (degrade): spend=${ctx.currentSpend} + est=${ctx.estimatedCost} > budget=${ctx.budget}`);
    this.name = 'BudgetExceededDegrade';
    this.orgId = ctx.orgId;
    this.estimatedCost = ctx.estimatedCost;
    this.currentSpend = ctx.currentSpend;
    this.budget = ctx.budget;
  }
}

export class BudgetExceededHalt extends Error {
  readonly orgId: string;
  readonly estimatedCost: number;
  readonly currentSpend: number;
  readonly budget: number;

  constructor(ctx: BudgetErrorContext) {
    super(`Budget exceeded (halt): org halted for remainder of month`);
    this.name = 'BudgetExceededHalt';
    this.orgId = ctx.orgId;
    this.estimatedCost = ctx.estimatedCost;
    this.currentSpend = ctx.currentSpend;
    this.budget = ctx.budget;
  }
}

export function isBudgetError(e: unknown): e is BudgetExceededDegrade | BudgetExceededHalt {
  return e instanceof BudgetExceededDegrade || e instanceof BudgetExceededHalt;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/evaluator test budget/errors`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/budget/errors.ts packages/evaluator/tests/budget/errors.test.ts
git commit -m "feat(evaluator): BudgetExceededDegrade/Halt error types"
```

### Task 2.3: callWithCostTracking wrapper (happy path)

**Files:**
- Create: `packages/evaluator/src/llm/callWithCostTracking.ts`
- Test: `packages/evaluator/tests/llm/callWithCostTracking.test.ts`

- [ ] **Step 1: Write the failing test (happy path only)**

```typescript
// packages/evaluator/tests/llm/callWithCostTracking.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callWithCostTracking } from '../../src/llm/callWithCostTracking';

describe('callWithCostTracking — happy path', () => {
  let mockLlmClient: { call: ReturnType<typeof vi.fn> };
  let mockEnforceBudget: ReturnType<typeof vi.fn>;
  let mockInsertLedger: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLlmClient = {
      call: vi.fn().mockResolvedValue({
        text: 'response body',
        usage: { input_tokens: 500, output_tokens: 100 },
      }),
    };
    mockEnforceBudget = vi.fn().mockResolvedValue(undefined);
    mockInsertLedger = vi.fn().mockResolvedValue(undefined);
  });

  it('writes ledger row on successful call', async () => {
    const result = await callWithCostTracking({
      orgId: 'org-1',
      eventType: 'facet_extraction',
      model: 'claude-haiku-4-5',
      refType: 'request_body_facet',
      refId: 'facet-1',
      prompt: { system: 's', user: 'u', maxTokens: 256 },
      estimatedInputTokens: 500,
    }, { llmClient: mockLlmClient, enforceBudget: mockEnforceBudget, insertLedger: mockInsertLedger });

    expect(mockEnforceBudget).toHaveBeenCalledOnce();
    expect(mockLlmClient.call).toHaveBeenCalledOnce();
    expect(mockInsertLedger).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      eventType: 'facet_extraction',
      model: 'claude-haiku-4-5',
      tokensInput: 500,
      tokensOutput: 100,
      refType: 'request_body_facet',
      refId: 'facet-1',
    }));
    expect(mockInsertLedger.mock.calls[0][0].costUsd).toBeCloseTo(0.0008, 6);
    expect(result.response.text).toBe('response body');
    expect(result.cost).toBeCloseTo(0.0008, 6);
  });

  it('enforces budget before calling LLM', async () => {
    const order: string[] = [];
    mockEnforceBudget.mockImplementation(() => { order.push('enforce'); return Promise.resolve(); });
    mockLlmClient.call.mockImplementation(() => { order.push('call'); return Promise.resolve({ text: '', usage: { input_tokens: 0, output_tokens: 0 } }); });

    await callWithCostTracking({
      orgId: 'o', eventType: 'deep_analysis', model: 'claude-haiku-4-5',
      prompt: { system: '', user: '', maxTokens: 10 }, estimatedInputTokens: 100,
    }, { llmClient: mockLlmClient, enforceBudget: mockEnforceBudget, insertLedger: mockInsertLedger });

    expect(order).toEqual(['enforce', 'call']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/evaluator test llm/callWithCostTracking`
Expected: FAIL (module not found)

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/evaluator/src/llm/callWithCostTracking.ts
import { calculateCost } from './pricing';

export interface LlmCallParams {
  orgId: string;
  eventType: 'facet_extraction' | 'deep_analysis';
  model: string;
  refType?: 'request_body_facet' | 'evaluation_report';
  refId?: string;
  prompt: { system: string; user: string; maxTokens: number };
  estimatedInputTokens: number;
}

export interface LlmResponse {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface LlmClient {
  call(args: { model: string; system: string; user: string; maxTokens: number }): Promise<LlmResponse>;
}

export interface LedgerRow {
  orgId: string;
  eventType: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  refType?: string;
  refId?: string;
}

export interface CostTrackingDeps {
  llmClient: LlmClient;
  enforceBudget: (orgId: string, estimatedCost: number) => Promise<void>;
  insertLedger: (row: LedgerRow) => Promise<void>;
}

export async function callWithCostTracking(
  params: LlmCallParams,
  deps: CostTrackingDeps,
): Promise<{ response: LlmResponse; cost: number }> {
  const estimatedCost = calculateCost(params.model, params.estimatedInputTokens, params.prompt.maxTokens);
  await deps.enforceBudget(params.orgId, estimatedCost);

  const response = await deps.llmClient.call({
    model: params.model,
    system: params.prompt.system,
    user: params.prompt.user,
    maxTokens: params.prompt.maxTokens,
  });

  if (!response.usage) {
    throw new Error('LLM response missing usage; cannot write ledger');
  }

  const actualCost = calculateCost(params.model, response.usage.input_tokens, response.usage.output_tokens);

  await deps.insertLedger({
    orgId: params.orgId,
    eventType: params.eventType,
    model: params.model,
    tokensInput: response.usage.input_tokens,
    tokensOutput: response.usage.output_tokens,
    costUsd: actualCost,
    refType: params.refType,
    refId: params.refId,
  });

  return { response, cost: actualCost };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/evaluator test llm/callWithCostTracking`
Expected: 2 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/llm/callWithCostTracking.ts packages/evaluator/tests/llm/callWithCostTracking.test.ts
git commit -m "feat(evaluator): callWithCostTracking wrapper (happy path)"
```

### Task 2.4: callWithCostTracking error paths

**Files:**
- Modify: `packages/evaluator/tests/llm/callWithCostTracking.test.ts`

- [ ] **Step 1: Add failing tests for error paths**

```typescript
// Append to packages/evaluator/tests/llm/callWithCostTracking.test.ts

describe('callWithCostTracking — error paths (D4: no ledger on api error)', () => {
  let mockLlmClient: { call: ReturnType<typeof vi.fn> };
  let mockEnforceBudget: ReturnType<typeof vi.fn>;
  let mockInsertLedger: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLlmClient = { call: vi.fn() };
    mockEnforceBudget = vi.fn().mockResolvedValue(undefined);
    mockInsertLedger = vi.fn().mockResolvedValue(undefined);
  });

  it('does not write ledger when budget gate throws', async () => {
    mockEnforceBudget.mockRejectedValue(new Error('budget exceeded'));

    await expect(callWithCostTracking({
      orgId: 'o', eventType: 'facet_extraction', model: 'claude-haiku-4-5',
      prompt: { system: '', user: '', maxTokens: 10 }, estimatedInputTokens: 100,
    }, { llmClient: mockLlmClient, enforceBudget: mockEnforceBudget, insertLedger: mockInsertLedger })).rejects.toThrow(/budget exceeded/);

    expect(mockLlmClient.call).not.toHaveBeenCalled();
    expect(mockInsertLedger).not.toHaveBeenCalled();
  });

  it('does not write ledger when LLM call throws (5xx)', async () => {
    mockLlmClient.call.mockRejectedValue(new Error('Anthropic 503'));

    await expect(callWithCostTracking({
      orgId: 'o', eventType: 'facet_extraction', model: 'claude-haiku-4-5',
      prompt: { system: '', user: '', maxTokens: 10 }, estimatedInputTokens: 100,
    }, { llmClient: mockLlmClient, enforceBudget: mockEnforceBudget, insertLedger: mockInsertLedger })).rejects.toThrow(/Anthropic 503/);

    expect(mockInsertLedger).not.toHaveBeenCalled();
  });

  it('does not write ledger when response lacks usage', async () => {
    mockLlmClient.call.mockResolvedValue({ text: 'x', usage: undefined as any });

    await expect(callWithCostTracking({
      orgId: 'o', eventType: 'facet_extraction', model: 'claude-haiku-4-5',
      prompt: { system: '', user: '', maxTokens: 10 }, estimatedInputTokens: 100,
    }, { llmClient: mockLlmClient, enforceBudget: mockEnforceBudget, insertLedger: mockInsertLedger })).rejects.toThrow(/missing usage/);

    expect(mockInsertLedger).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

The implementation from Task 2.3 already handles these paths. Run: `pnpm --filter @aide/evaluator test llm/callWithCostTracking`
Expected: 5 tests pass total

- [ ] **Step 3: Commit**

```bash
git add packages/evaluator/tests/llm/callWithCostTracking.test.ts
git commit -m "test(evaluator): callWithCostTracking error paths (no ledger on failure)"
```

---

## Part 3 — Budget enforcement gate

### Task 3.1: enforceBudget unit tests (table-driven)

**Files:**
- Create: `packages/evaluator/src/budget/enforceBudget.ts`
- Test: `packages/evaluator/tests/budget/enforceBudget.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/evaluator/tests/budget/enforceBudget.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enforceBudget } from '../../src/budget/enforceBudget';
import { BudgetExceededDegrade, BudgetExceededHalt } from '../../src/budget/errors';

interface OrgState {
  id: string;
  llm_monthly_budget_usd: number | null;
  llm_budget_overage_behavior: 'degrade' | 'halt';
  llm_halted_until_month_end: boolean;
  halt_set_at?: Date;
}

describe('enforceBudget', () => {
  let mockLoadOrg: ReturnType<typeof vi.fn>;
  let mockGetMonthSpend: ReturnType<typeof vi.fn>;
  let mockSetHalt: ReturnType<typeof vi.fn>;
  let mockClearHalt: ReturnType<typeof vi.fn>;
  let now = new Date('2026-04-15T12:00:00Z');

  beforeEach(() => {
    mockLoadOrg = vi.fn();
    mockGetMonthSpend = vi.fn();
    mockSetHalt = vi.fn().mockResolvedValue(undefined);
    mockClearHalt = vi.fn().mockResolvedValue(undefined);
  });

  const baseOrg: OrgState = {
    id: 'org-1',
    llm_monthly_budget_usd: 50,
    llm_budget_overage_behavior: 'degrade',
    llm_halted_until_month_end: false,
  };

  const call = (est: number, overrides: Partial<OrgState> = {}) =>
    enforceBudget('org-1', est, {
      loadOrg: mockLoadOrg.mockResolvedValue({ ...baseOrg, ...overrides }),
      getMonthSpend: mockGetMonthSpend,
      setHalt: mockSetHalt,
      clearHalt: mockClearHalt,
      now: () => now,
    });

  it('passes when budget is NULL (unlimited)', async () => {
    await expect(call(10, { llm_monthly_budget_usd: null })).resolves.toBeUndefined();
    expect(mockGetMonthSpend).not.toHaveBeenCalled();
  });

  it('passes when spend + est is within budget', async () => {
    mockGetMonthSpend.mockResolvedValue(20);
    await expect(call(10)).resolves.toBeUndefined();
  });

  it('passes when spend + est equals budget exactly', async () => {
    mockGetMonthSpend.mockResolvedValue(40);
    await expect(call(10)).resolves.toBeUndefined();
  });

  it('throws BudgetExceededDegrade when over and behavior=degrade', async () => {
    mockGetMonthSpend.mockResolvedValue(49);
    await expect(call(5)).rejects.toBeInstanceOf(BudgetExceededDegrade);
    expect(mockSetHalt).not.toHaveBeenCalled();
  });

  it('throws BudgetExceededHalt and sets halt flag when behavior=halt', async () => {
    mockGetMonthSpend.mockResolvedValue(49);
    await expect(call(5, { llm_budget_overage_behavior: 'halt' })).rejects.toBeInstanceOf(BudgetExceededHalt);
    expect(mockSetHalt).toHaveBeenCalledWith('org-1');
  });

  it('throws BudgetExceededHalt immediately if halt flag already set same month', async () => {
    await expect(call(5, { llm_halted_until_month_end: true, halt_set_at: new Date('2026-04-10T00:00:00Z') })).rejects.toBeInstanceOf(BudgetExceededHalt);
    expect(mockGetMonthSpend).not.toHaveBeenCalled();
  });

  it('auto-clears halt flag when new month and re-evaluates', async () => {
    now = new Date('2026-05-01T00:30:00Z');
    mockGetMonthSpend.mockResolvedValue(0);
    await expect(call(5, {
      llm_halted_until_month_end: true,
      halt_set_at: new Date('2026-04-20T00:00:00Z'),
    })).resolves.toBeUndefined();
    expect(mockClearHalt).toHaveBeenCalledWith('org-1');
  });

  it('preserves halt across days within same month', async () => {
    now = new Date('2026-04-30T23:59:00Z');
    await expect(call(5, {
      llm_halted_until_month_end: true,
      halt_set_at: new Date('2026-04-05T00:00:00Z'),
    })).rejects.toBeInstanceOf(BudgetExceededHalt);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/evaluator test budget/enforceBudget`
Expected: FAIL (module not found)

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/evaluator/src/budget/enforceBudget.ts
import { BudgetExceededDegrade, BudgetExceededHalt } from './errors';

export interface EnforceBudgetDeps {
  loadOrg: (orgId: string) => Promise<{
    id: string;
    llm_monthly_budget_usd: number | null;
    llm_budget_overage_behavior: 'degrade' | 'halt';
    llm_halted_until_month_end: boolean;
    halt_set_at?: Date;
  }>;
  getMonthSpend: (orgId: string, monthStart: Date) => Promise<number>;
  setHalt: (orgId: string) => Promise<void>;
  clearHalt: (orgId: string) => Promise<void>;
  now: () => Date;
}

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function sameMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

export async function enforceBudget(
  orgId: string,
  estimatedCost: number,
  deps: EnforceBudgetDeps,
): Promise<void> {
  const org = await deps.loadOrg(orgId);
  const now = deps.now();

  if (org.llm_halted_until_month_end) {
    if (org.halt_set_at && sameMonth(org.halt_set_at, now)) {
      throw new BudgetExceededHalt({
        orgId, estimatedCost,
        currentSpend: org.llm_monthly_budget_usd ?? 0,
        budget: org.llm_monthly_budget_usd ?? 0,
      });
    }
    await deps.clearHalt(orgId);
  }

  if (org.llm_monthly_budget_usd == null) {
    return;
  }

  const currentSpend = await deps.getMonthSpend(orgId, monthStartUtc(now));

  if (currentSpend + estimatedCost <= org.llm_monthly_budget_usd) {
    return;
  }

  const ctx = {
    orgId, estimatedCost, currentSpend, budget: org.llm_monthly_budget_usd,
  };
  if (org.llm_budget_overage_behavior === 'halt') {
    await deps.setHalt(orgId);
    throw new BudgetExceededHalt(ctx);
  }
  throw new BudgetExceededDegrade(ctx);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/evaluator test budget/enforceBudget`
Expected: 8 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/budget/enforceBudget.ts packages/evaluator/tests/budget/enforceBudget.test.ts
git commit -m "feat(evaluator): enforceBudget gate (degrade/halt + month rollover)"
```

### Task 3.2: Gateway integration — concrete deps wiring

**Files:**
- Create: `apps/gateway/src/workers/evaluator/budgetDeps.ts`
- Test: `apps/gateway/tests/workers/evaluator/budgetDeps.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// apps/gateway/tests/workers/evaluator/budgetDeps.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createBudgetDeps } from '../../../src/workers/evaluator/budgetDeps';
import { getTestDb } from '../../helpers/db';

describe('budgetDeps (integration, real DB)', () => {
  const db = getTestDb();
  let orgId: string;

  beforeEach(async () => {
    await db.query('TRUNCATE organizations, llm_usage_events CASCADE');
    const r = await db.query(
      `INSERT INTO organizations (name, llm_monthly_budget_usd, llm_budget_overage_behavior)
       VALUES ('t', 50, 'degrade') RETURNING id`,
    );
    orgId = r.rows[0].id;
  });

  it('loadOrg returns current row', async () => {
    const deps = createBudgetDeps(db);
    const org = await deps.loadOrg(orgId);
    expect(org.llm_monthly_budget_usd).toBe('50.00');
    expect(org.llm_budget_overage_behavior).toBe('degrade');
  });

  it('getMonthSpend sums only current-month ledger rows', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    await db.query(
      `INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd, created_at)
       VALUES
         ($1, 'facet_extraction', 'claude-haiku-4-5', 100, 100, 1.5, '2026-04-01T00:00:00Z'),
         ($1, 'deep_analysis',    'claude-sonnet-4-6', 200, 200, 2.5, '2026-04-10T00:00:00Z'),
         ($1, 'facet_extraction', 'claude-haiku-4-5', 100, 100, 0.5, '2026-03-31T23:59:00Z'),
         ($1, 'facet_extraction', 'claude-haiku-4-5', 100, 100, 0.7, '2026-05-01T00:00:00Z')`,
      [orgId],
    );
    const deps = createBudgetDeps(db);
    const spend = await deps.getMonthSpend(orgId, new Date('2026-04-01T00:00:00Z'));
    expect(Number(spend)).toBeCloseTo(4.0, 6);
  });

  it('setHalt / clearHalt flip the flag', async () => {
    const deps = createBudgetDeps(db);
    await deps.setHalt(orgId);
    const after = await deps.loadOrg(orgId);
    expect(after.llm_halted_until_month_end).toBe(true);
    await deps.clearHalt(orgId);
    const cleared = await deps.loadOrg(orgId);
    expect(cleared.llm_halted_until_month_end).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/gateway test workers/evaluator/budgetDeps`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

```typescript
// apps/gateway/src/workers/evaluator/budgetDeps.ts
import type { Pool } from 'pg';
import type { EnforceBudgetDeps } from '@aide/evaluator/budget/enforceBudget';

export function createBudgetDeps(db: Pool): EnforceBudgetDeps {
  return {
    async loadOrg(orgId) {
      const { rows } = await db.query(
        `SELECT id, llm_monthly_budget_usd, llm_budget_overage_behavior,
                llm_halted_until_month_end, updated_at AS halt_set_at
         FROM organizations WHERE id = $1`,
        [orgId],
      );
      if (!rows[0]) throw new Error(`Org not found: ${orgId}`);
      return {
        id: rows[0].id,
        llm_monthly_budget_usd: rows[0].llm_monthly_budget_usd == null
          ? null
          : Number(rows[0].llm_monthly_budget_usd),
        llm_budget_overage_behavior: rows[0].llm_budget_overage_behavior,
        llm_halted_until_month_end: rows[0].llm_halted_until_month_end,
        halt_set_at: rows[0].halt_set_at ? new Date(rows[0].halt_set_at) : undefined,
      };
    },

    async getMonthSpend(orgId, monthStart) {
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM llm_usage_events
         WHERE org_id = $1 AND created_at >= $2`,
        [orgId, monthStart],
      );
      return Number(rows[0].total);
    },

    async setHalt(orgId) {
      await db.query(
        `UPDATE organizations SET llm_halted_until_month_end = true, updated_at = now() WHERE id = $1`,
        [orgId],
      );
    },

    async clearHalt(orgId) {
      await db.query(
        `UPDATE organizations SET llm_halted_until_month_end = false, updated_at = now() WHERE id = $1`,
        [orgId],
      );
    },

    now: () => new Date(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/gateway test workers/evaluator/budgetDeps`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/evaluator/budgetDeps.ts apps/gateway/tests/workers/evaluator/budgetDeps.integration.test.ts
git commit -m "feat(gateway): concrete budget deps wired to Postgres"
```

### Task 3.3: Gateway ledger writer

**Files:**
- Create: `apps/gateway/src/workers/evaluator/ledgerWriter.ts`
- Test: `apps/gateway/tests/workers/evaluator/ledgerWriter.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/gateway/tests/workers/evaluator/ledgerWriter.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createLedgerWriter } from '../../../src/workers/evaluator/ledgerWriter';
import { getTestDb } from '../../helpers/db';

describe('ledgerWriter (integration)', () => {
  const db = getTestDb();
  let orgId: string;

  beforeEach(async () => {
    await db.query('TRUNCATE organizations, llm_usage_events CASCADE');
    const r = await db.query(`INSERT INTO organizations (name) VALUES ('t') RETURNING id`);
    orgId = r.rows[0].id;
  });

  it('inserts a ledger row with all fields', async () => {
    const write = createLedgerWriter(db);
    await write({
      orgId,
      eventType: 'facet_extraction',
      model: 'claude-haiku-4-5',
      tokensInput: 100,
      tokensOutput: 50,
      costUsd: 0.0002,
      refType: 'request_body_facet',
      refId: '11111111-1111-1111-1111-111111111111',
    });

    const { rows } = await db.query('SELECT * FROM llm_usage_events WHERE org_id = $1', [orgId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('facet_extraction');
    expect(Number(rows[0].cost_usd)).toBeCloseTo(0.0002, 6);
  });

  it('inserts with null refType / refId', async () => {
    const write = createLedgerWriter(db);
    await write({
      orgId, eventType: 'deep_analysis', model: 'claude-sonnet-4-6',
      tokensInput: 1, tokensOutput: 1, costUsd: 0.0001,
    });
    const { rows } = await db.query('SELECT ref_type, ref_id FROM llm_usage_events');
    expect(rows[0].ref_type).toBeNull();
    expect(rows[0].ref_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/gateway test workers/evaluator/ledgerWriter`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

```typescript
// apps/gateway/src/workers/evaluator/ledgerWriter.ts
import type { Pool } from 'pg';
import type { LedgerRow } from '@aide/evaluator/llm/callWithCostTracking';

export function createLedgerWriter(db: Pool): (row: LedgerRow) => Promise<void> {
  return async (row) => {
    await db.query(
      `INSERT INTO llm_usage_events
         (org_id, event_type, model, tokens_input, tokens_output, cost_usd, ref_type, ref_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.orgId, row.eventType, row.model,
        row.tokensInput, row.tokensOutput, row.costUsd,
        row.refType ?? null, row.refId ?? null,
      ],
    );
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/gateway test workers/evaluator/ledgerWriter`
Expected: 2 tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/evaluator/ledgerWriter.ts apps/gateway/tests/workers/evaluator/ledgerWriter.integration.test.ts
git commit -m "feat(gateway): ledger writer for llm_usage_events"
```

---

## Part 4 — Cost summary tRPC endpoint

### Task 4.1: Cost summary query module

**Files:**
- Create: `apps/api/src/services/evaluatorCost.ts`
- Test: `apps/api/tests/integration/services/evaluatorCost.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/tests/integration/services/evaluatorCost.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getCostSummary } from '../../../src/services/evaluatorCost';
import { getTestDb, seedOrg } from '../../helpers/db';

describe('getCostSummary', () => {
  const db = getTestDb();
  let orgId: string;

  beforeEach(async () => {
    await db.query('TRUNCATE organizations, llm_usage_events CASCADE');
    orgId = await seedOrg(db, { llm_monthly_budget_usd: 50 });
  });

  it('returns zeros when no usage', async () => {
    const s = await getCostSummary(db, orgId, new Date('2026-04-15T12:00:00Z'));
    expect(s.currentMonthSpendUsd).toBe(0);
    expect(s.budgetUsd).toBe(50);
    expect(s.remainingUsd).toBe(50);
    expect(s.breakdown.facetExtraction.calls).toBe(0);
    expect(s.warningThresholdReached).toBe(false);
    expect(s.halted).toBe(false);
  });

  it('aggregates by event_type and model', async () => {
    await db.query(`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd, created_at)
      VALUES
        ($1, 'facet_extraction', 'claude-haiku-4-5', 100, 50, 1.00, '2026-04-05T00:00:00Z'),
        ($1, 'facet_extraction', 'claude-haiku-4-5', 200, 50, 2.00, '2026-04-10T00:00:00Z'),
        ($1, 'deep_analysis',    'claude-sonnet-4-6', 500, 100, 5.00, '2026-04-12T00:00:00Z')
    `, [orgId]);

    const s = await getCostSummary(db, orgId, new Date('2026-04-15T12:00:00Z'));
    expect(s.currentMonthSpendUsd).toBe(8);
    expect(s.breakdown.facetExtraction).toEqual({ calls: 2, costUsd: 3 });
    expect(s.breakdown.deepAnalysis).toEqual({ calls: 1, costUsd: 5 });
    expect(s.breakdownByModel).toEqual([
      { model: 'claude-sonnet-4-6', calls: 1, costUsd: 5 },
      { model: 'claude-haiku-4-5',  calls: 2, costUsd: 3 },
    ]);
  });

  it('computes projected end-of-month linearly', async () => {
    await db.query(`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd, created_at)
      VALUES ($1, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 10.00, '2026-04-10T00:00:00Z')
    `, [orgId]);
    // April has 30 days; on day 15 at 12:00 UTC, elapsed ≈ 14.5 days
    // projected = 10 * 30/14.5 ≈ 20.69
    const s = await getCostSummary(db, orgId, new Date('2026-04-15T12:00:00Z'));
    expect(s.projectedEndOfMonthUsd).toBeGreaterThan(20);
    expect(s.projectedEndOfMonthUsd).toBeLessThan(22);
  });

  it('flags warningThresholdReached at 80%', async () => {
    await db.query(`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd, created_at)
      VALUES ($1, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 40.00, '2026-04-05T00:00:00Z')
    `, [orgId]);
    const s = await getCostSummary(db, orgId, new Date('2026-04-15T12:00:00Z'));
    expect(s.warningThresholdReached).toBe(true);
  });

  it('returns unlimited when budget is NULL', async () => {
    await db.query(`UPDATE organizations SET llm_monthly_budget_usd = NULL WHERE id = $1`, [orgId]);
    const s = await getCostSummary(db, orgId, new Date('2026-04-15T12:00:00Z'));
    expect(s.budgetUsd).toBeNull();
    expect(s.remainingUsd).toBeNull();
    expect(s.warningThresholdReached).toBe(false);
  });

  it('includes last 6 months historical totals', async () => {
    await db.query(`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd, created_at)
      VALUES
        ($1, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 5.00, '2025-11-15T00:00:00Z'),
        ($1, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 3.00, '2026-02-15T00:00:00Z')
    `, [orgId]);
    const s = await getCostSummary(db, orgId, new Date('2026-04-15T12:00:00Z'));
    expect(s.historicalMonths).toHaveLength(6);
    const nov = s.historicalMonths.find(m => m.month === '2025-11');
    expect(nov?.costUsd).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/api test integration/services/evaluatorCost`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

```typescript
// apps/api/src/services/evaluatorCost.ts
import type { Pool } from 'pg';

export interface CostSummary {
  currentMonthSpendUsd: number;
  budgetUsd: number | null;
  remainingUsd: number | null;
  projectedEndOfMonthUsd: number;
  breakdown: {
    facetExtraction: { calls: number; costUsd: number };
    deepAnalysis: { calls: number; costUsd: number };
  };
  breakdownByModel: Array<{ model: string; calls: number; costUsd: number }>;
  historicalMonths: Array<{ month: string; costUsd: number }>;
  warningThresholdReached: boolean;
  halted: boolean;
}

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function daysInMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

function elapsedDays(now: Date): number {
  const ms = now.getTime() - monthStartUtc(now).getTime();
  return ms / (24 * 60 * 60 * 1000);
}

export async function getCostSummary(
  db: Pool,
  orgId: string,
  now: Date = new Date(),
): Promise<CostSummary> {
  const mStart = monthStartUtc(now);

  const orgRes = await db.query(
    `SELECT llm_monthly_budget_usd, llm_halted_until_month_end
     FROM organizations WHERE id = $1`,
    [orgId],
  );
  const budget = orgRes.rows[0]?.llm_monthly_budget_usd == null
    ? null
    : Number(orgRes.rows[0].llm_monthly_budget_usd);
  const halted = orgRes.rows[0]?.llm_halted_until_month_end ?? false;

  const byType = await db.query(
    `SELECT event_type, COUNT(*)::int AS calls, COALESCE(SUM(cost_usd), 0) AS total
     FROM llm_usage_events
     WHERE org_id = $1 AND created_at >= $2
     GROUP BY event_type`,
    [orgId, mStart],
  );
  const facet = byType.rows.find(r => r.event_type === 'facet_extraction');
  const deep = byType.rows.find(r => r.event_type === 'deep_analysis');

  const byModel = await db.query(
    `SELECT model, COUNT(*)::int AS calls, COALESCE(SUM(cost_usd), 0) AS total
     FROM llm_usage_events
     WHERE org_id = $1 AND created_at >= $2
     GROUP BY model
     ORDER BY total DESC`,
    [orgId, mStart],
  );

  const hist = await db.query(
    `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
            COALESCE(SUM(cost_usd), 0) AS total
     FROM llm_usage_events
     WHERE org_id = $1
       AND created_at >= $2
     GROUP BY 1 ORDER BY 1`,
    [orgId, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1))],
  );

  const historicalMonths: Array<{ month: string; costUsd: number }> = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const found = hist.rows.find(r => r.month === key);
    historicalMonths.push({ month: key, costUsd: found ? Number(found.total) : 0 });
  }

  const currentMonthSpendUsd = (facet ? Number(facet.total) : 0) + (deep ? Number(deep.total) : 0);
  const elapsed = Math.max(elapsedDays(now), 0.5);
  const projectedEndOfMonthUsd = currentMonthSpendUsd * (daysInMonth(now) / elapsed);

  return {
    currentMonthSpendUsd,
    budgetUsd: budget,
    remainingUsd: budget == null ? null : budget - currentMonthSpendUsd,
    projectedEndOfMonthUsd,
    breakdown: {
      facetExtraction: facet ? { calls: facet.calls, costUsd: Number(facet.total) } : { calls: 0, costUsd: 0 },
      deepAnalysis: deep ? { calls: deep.calls, costUsd: Number(deep.total) } : { calls: 0, costUsd: 0 },
    },
    breakdownByModel: byModel.rows.map(r => ({
      model: r.model, calls: r.calls, costUsd: Number(r.total),
    })),
    historicalMonths,
    warningThresholdReached: budget != null && currentMonthSpendUsd >= budget * 0.8,
    halted,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/api test integration/services/evaluatorCost`
Expected: 6 tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/evaluatorCost.ts apps/api/tests/integration/services/evaluatorCost.test.ts
git commit -m "feat(api): getCostSummary service (monthly aggregation + projection)"
```

### Task 4.2: Extend evaluatorRouter with costSummary procedure

**DO NOT create `evaluatorCost.ts`.** Extend the existing `evaluatorRouter` at `apps/api/src/trpc/routers/evaluator.ts` with a new `costSummary` procedure, following the pattern of the existing `status` procedure.

**Files:**
- Modify: `apps/api/src/trpc/routers/evaluator.ts`
- Test: `apps/api/tests/integration/trpc/evaluatorCostSummary.test.ts`

- [ ] **Step 1: Inspect existing `status` procedure in evaluator.ts for pattern**

Run:
```bash
cat apps/api/src/trpc/routers/evaluator.ts | head -80
```

Note the patterns:
- Uses `evaluatorProcedure` from `./_evaluatorGate.js` (applies org-level feature-flag gating)
- Checks permissions via `can(ctx.perm, { type: "evaluator.read_status", orgId })`
- Throws `TRPCError({ code: "FORBIDDEN" })` when permission denied
- Takes input via Zod `.input(z.object({ orgId: z.string().uuid() }))`

- [ ] **Step 2: Write the failing integration test**

```typescript
// apps/api/tests/integration/trpc/evaluatorCostSummary.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, type TestDb } from "../../factories/db";
import { makeOrg } from "../../factories/org";
import { makeUser } from "../../factories/user";
import { callerFor } from "../../factories/caller";
import { sql } from "drizzle-orm";

describe("admin.evaluator.costSummary (integration)", () => {
  let testDb: TestDb;

  beforeAll(async () => { testDb = await setupTestDb(); });
  afterAll(async () => { await testDb.stop(); });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE organizations, llm_usage_events, role_assignments, users CASCADE`);
  });

  it("returns summary for org_admin", async () => {
    const org = await makeOrg(testDb.db, { llmMonthlyBudgetUsd: "50.00" } as any);
    const user = await makeUser(testDb.db);
    await testDb.db.execute(sql`
      INSERT INTO role_assignments (user_id, role, scope_type, scope_id)
      VALUES (${user.id}, 'org_admin', 'organization', ${org.id})
    `);

    const caller = await callerFor({ testDb, userId: user.id });
    const summary = await caller.evaluator.costSummary({ orgId: org.id });
    expect(summary.budgetUsd).toBe(50);
    expect(summary.currentMonthSpendUsd).toBe(0);
  });

  it("rejects a plain member", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db);
    await testDb.db.execute(sql`
      INSERT INTO role_assignments (user_id, role, scope_type, scope_id)
      VALUES (${user.id}, 'member', 'organization', ${org.id})
    `);

    const caller = await callerFor({ testDb, userId: user.id });
    await expect(caller.evaluator.costSummary({ orgId: org.id })).rejects.toThrow(/FORBIDDEN/i);
  });

  it("rejects org_admin of a different org", async () => {
    const orgA = await makeOrg(testDb.db);
    const orgB = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db);
    await testDb.db.execute(sql`
      INSERT INTO role_assignments (user_id, role, scope_type, scope_id)
      VALUES (${user.id}, 'org_admin', 'organization', ${orgA.id})
    `);
    const caller = await callerFor({ testDb, userId: user.id });
    await expect(caller.evaluator.costSummary({ orgId: orgB.id })).rejects.toThrow(/FORBIDDEN/i);
  });
});
```

Note: `callerFor(...)` signature may differ from what's shown — check `apps/api/tests/factories/caller.ts` for the actual API. Adapt the test to the real shape (likely passes `{ db, userId }` or similar).

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @aide/api test:integration evaluatorCostSummary`
Expected: FAIL (procedure not defined)

- [ ] **Step 4: Add `costSummary` procedure to evaluatorRouter**

Modify `apps/api/src/trpc/routers/evaluator.ts`. Add the new procedure alongside `status`:

```typescript
import { getCostSummary } from "../../services/evaluatorCost";

export const evaluatorRouter = router({
  status: evaluatorProcedure
    /* …existing implementation… */,

  costSummary: evaluatorProcedure
    .input(z.object({ orgId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "evaluator.view_cost", orgId: input.orgId })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      return getCostSummary(ctx.db, input.orgId);
    }),
});
```

The new Action type `evaluator.view_cost` was added in Task 1.2. No router-registration change needed (evaluatorRouter is already registered in `router.ts`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @aide/api test:integration evaluatorCostSummary`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/trpc/routers/evaluator.ts apps/api/tests/integration/trpc/evaluatorCostSummary.test.ts
git commit -m "feat(api): evaluator.costSummary tRPC procedure (extends existing router)"
```

Note: the `getCostSummary` service from Task 4.1 currently expects a raw pg Pool. If `ctx.db` is a Drizzle instance, adapt the service to accept Drizzle instead (or expose the Pool on ctx). The simplest adjustment is to rewrite the service queries using Drizzle's `db.execute(sql\`...\`)` — see the conventions preamble.

---

## Part 5 — Settings form additions (Zod resolver + cost/facet fieldsets)

### Task 5.1: Re-add Zod resolver to SettingsForm

**Files:**
- Modify: `apps/web/src/components/evaluator/SettingsForm.tsx`
- Create: `apps/web/src/components/evaluator/settingsSchema.ts`
- Test: `apps/web/tests/components/evaluator/SettingsForm.resolver.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/tests/components/evaluator/SettingsForm.resolver.test.tsx
import { describe, it, expect } from 'vitest';
import { settingsSchema } from '../../../src/components/evaluator/settingsSchema';

describe('settingsSchema (handoff tech-debt #1 fix)', () => {
  it('round-trips empty numeric field as undefined, not 0', () => {
    // Native select / number input returns "" when cleared
    const result = settingsSchema.parse({
      evaluator_enabled: true,
      llm_eval_enabled: false,
      llm_monthly_budget_usd: '',
      llm_budget_overage_behavior: 'degrade',
      llm_facet_enabled: false,
    });
    expect(result.llm_monthly_budget_usd).toBeUndefined();
  });

  it('parses numeric string "10.50" as 10.5', () => {
    const r = settingsSchema.parse({
      evaluator_enabled: true,
      llm_eval_enabled: false,
      llm_monthly_budget_usd: '10.50',
      llm_budget_overage_behavior: 'degrade',
      llm_facet_enabled: false,
    });
    expect(r.llm_monthly_budget_usd).toBe(10.5);
  });

  it('rejects negative budget', () => {
    expect(() => settingsSchema.parse({
      evaluator_enabled: true, llm_eval_enabled: false,
      llm_monthly_budget_usd: '-5',
      llm_budget_overage_behavior: 'degrade',
      llm_facet_enabled: false,
    })).toThrow(/non-negative/i);
  });

  it('requires llm_eval_enabled=true when llm_facet_enabled=true', () => {
    expect(() => settingsSchema.parse({
      evaluator_enabled: true, llm_eval_enabled: false,
      llm_monthly_budget_usd: '',
      llm_budget_overage_behavior: 'degrade',
      llm_facet_enabled: true,
      llm_facet_model: 'claude-haiku-4-5',
    })).toThrow(/facet.+requires.+llm_eval/i);
  });

  it('requires facet_model when facet_enabled=true', () => {
    expect(() => settingsSchema.parse({
      evaluator_enabled: true, llm_eval_enabled: true, llm_eval_model: 'claude-sonnet-4-6',
      llm_monthly_budget_usd: '10',
      llm_budget_overage_behavior: 'degrade',
      llm_facet_enabled: true,
      llm_facet_model: '',
    })).toThrow(/facet_model/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/web test components/evaluator/SettingsForm.resolver`
Expected: FAIL (module not found)

- [ ] **Step 3: Write schema**

```typescript
// apps/web/src/components/evaluator/settingsSchema.ts
import { z } from 'zod';

const optionalNumericString = z
  .union([z.string(), z.number()])
  .transform((v) => {
    if (v === '' || v === null || v === undefined) return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  })
  .refine((v) => v === undefined || v >= 0, { message: 'Must be non-negative' });

export const settingsSchema = z.object({
  evaluator_enabled: z.boolean(),
  llm_eval_enabled: z.boolean(),
  llm_eval_model: z.string().optional(),
  llm_monthly_budget_usd: optionalNumericString,
  llm_budget_overage_behavior: z.enum(['degrade', 'halt']),
  llm_facet_enabled: z.boolean(),
  llm_facet_model: z.string().optional(),
}).superRefine((val, ctx) => {
  if (val.llm_facet_enabled && !val.llm_eval_enabled) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Facet extraction requires llm_eval to be enabled first',
      path: ['llm_facet_enabled'],
    });
  }
  if (val.llm_facet_enabled && !val.llm_facet_model) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Choose a facet_model when facet extraction is enabled',
      path: ['llm_facet_model'],
    });
  }
});

export type SettingsFormValues = z.infer<typeof settingsSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/web test components/evaluator/SettingsForm.resolver`
Expected: 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/evaluator/settingsSchema.ts apps/web/tests/components/evaluator/SettingsForm.resolver.test.tsx
git commit -m "feat(web): settingsSchema with native-select-safe numeric parsing"
```

### Task 5.2: SettingsForm — LLM Cost Control fieldset

**Files:**
- Modify: `apps/web/src/components/evaluator/SettingsForm.tsx`

- [ ] **Step 1: Add the fieldset JSX**

Modify `SettingsForm.tsx`. Locate the existing `<fieldset>` for evaluator settings and insert a new fieldset after it:

```tsx
<fieldset className="eval-fieldset">
  <legend>{t('settings.llmCost.title')}</legend>

  <label htmlFor="llm_monthly_budget_usd">
    {t('settings.llmCost.monthlyBudget')}
    <input
      id="llm_monthly_budget_usd"
      type="number"
      min="0"
      step="0.01"
      {...register('llm_monthly_budget_usd')}
      placeholder={t('settings.llmCost.budgetPlaceholder')}
    />
    <span className="help">{t('settings.llmCost.budgetHelp')}</span>
  </label>

  <label>
    {t('settings.llmCost.overageBehavior')}
    <div role="radiogroup">
      <label>
        <input type="radio" value="degrade" {...register('llm_budget_overage_behavior')} />
        {t('settings.llmCost.degrade')}
      </label>
      <label>
        <input type="radio" value="halt" {...register('llm_budget_overage_behavior')} />
        {t('settings.llmCost.halt')}
      </label>
    </div>
  </label>

  <a href="/admin/evaluator/costs" className="cost-dashboard-link">
    {t('settings.llmCost.viewDashboard')} →
  </a>
</fieldset>
```

- [ ] **Step 2: Wire the resolver**

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { settingsSchema, SettingsFormValues } from './settingsSchema';

// Replace existing useForm call:
const form = useForm<SettingsFormValues>({
  resolver: zodResolver(settingsSchema),
  defaultValues: {
    evaluator_enabled: org.evaluator_enabled,
    llm_eval_enabled: org.llm_eval_enabled,
    llm_eval_model: org.llm_eval_model ?? '',
    llm_monthly_budget_usd: org.llm_monthly_budget_usd ?? '',
    llm_budget_overage_behavior: org.llm_budget_overage_behavior ?? 'degrade',
    llm_facet_enabled: org.llm_facet_enabled ?? false,
    llm_facet_model: org.llm_facet_model ?? '',
  },
});
```

- [ ] **Step 3: Run existing Settings tests**

Run: `pnpm --filter @aide/web test components/evaluator/SettingsForm`
Expected: all prior tests still pass

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/evaluator/SettingsForm.tsx
git commit -m "feat(web): Settings LLM Cost fieldset (budget + overage behavior)"
```

### Task 5.3: SettingsForm — LLM Facet fieldset + dynamic warnings

**Files:**
- Modify: `apps/web/src/components/evaluator/SettingsForm.tsx`

- [ ] **Step 1: Add Facet fieldset**

Append after the Cost fieldset:

```tsx
<fieldset className="eval-fieldset">
  <legend>{t('settings.llmFacet.title')}</legend>

  <label>
    <input type="checkbox" {...register('llm_facet_enabled')} />
    {t('settings.llmFacet.enable')}
  </label>

  <label htmlFor="llm_facet_model">
    {t('settings.llmFacet.model')}
    <select id="llm_facet_model" {...register('llm_facet_model')}>
      <option value="">{t('settings.llmFacet.modelPlaceholder')}</option>
      <option value="claude-haiku-4-5">claude-haiku-4-5</option>
      <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
      <option value="claude-opus-4-7">claude-opus-4-7</option>
    </select>
    <span className="help">{t('settings.llmFacet.modelHelp')}</span>
  </label>
</fieldset>
```

- [ ] **Step 2: Add dynamic warning banners**

Above the fieldsets in the form JSX, insert:

```tsx
{watch('llm_eval_enabled') && !watch('llm_monthly_budget_usd') && (
  <Banner variant="warn">{t('settings.warnings.noBudget')}</Banner>
)}
{errors.llm_facet_enabled?.message && (
  <Banner variant="error">{errors.llm_facet_enabled.message}</Banner>
)}
{errors.llm_facet_model?.message && (
  <Banner variant="error">{errors.llm_facet_model.message}</Banner>
)}
```

Import the `Banner` component created in Part 17 — if not yet available, use a plain `<div className="banner banner--warn">` with the same text as a placeholder and refactor in Part 17.

- [ ] **Step 3: Add i18n keys**

Modify `apps/web/src/i18n/en.json`, `zh-Hant.json`, `ja.json` — add keys under `settings.llmCost.*`, `settings.llmFacet.*`, `settings.warnings.noBudget`. Example English:

```json
{
  "settings.llmCost.title": "LLM Cost Control",
  "settings.llmCost.monthlyBudget": "Monthly budget (USD)",
  "settings.llmCost.budgetPlaceholder": "Empty = unlimited",
  "settings.llmCost.budgetHelp": "Leave empty to allow unlimited LLM spend.",
  "settings.llmCost.overageBehavior": "Overage behavior",
  "settings.llmCost.degrade": "Degrade (skip over-budget calls)",
  "settings.llmCost.halt": "Halt (stop all LLM until next month)",
  "settings.llmCost.viewDashboard": "View cost dashboard",
  "settings.llmFacet.title": "LLM Facet Extraction",
  "settings.llmFacet.enable": "Enable facet extraction",
  "settings.llmFacet.model": "Facet model",
  "settings.llmFacet.modelPlaceholder": "Select model…",
  "settings.llmFacet.modelHelp": "Recommend haiku for cost-efficient extraction.",
  "settings.warnings.noBudget": "No budget set. LLM costs are unlimited."
}
```

Translate equivalently for zh-Hant and ja.

- [ ] **Step 4: Manual smoke**

Run: `pnpm --filter @aide/web dev` → open Settings → toggle facet_enabled without llm_eval_enabled → submit → see inline error; set budget=10 → warning disappears.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/evaluator/SettingsForm.tsx apps/web/src/i18n/
git commit -m "feat(web): Settings Facet fieldset + dynamic warnings"
```

---

## Part 6 — Cost dashboard page + admin widget

### Task 6.1: CostSummaryCard shared component

**Files:**
- Create: `apps/web/src/components/evaluator/CostSummaryCard.tsx`
- Test: `apps/web/tests/components/evaluator/CostSummaryCard.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/tests/components/evaluator/CostSummaryCard.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostSummaryCard } from '../../../src/components/evaluator/CostSummaryCard';

const mk = (partial: any) => ({
  currentMonthSpendUsd: 12.34,
  budgetUsd: 50,
  remainingUsd: 37.66,
  projectedEndOfMonthUsd: 18.5,
  breakdown: { facetExtraction: { calls: 0, costUsd: 0 }, deepAnalysis: { calls: 0, costUsd: 0 } },
  breakdownByModel: [],
  historicalMonths: [],
  warningThresholdReached: false,
  halted: false,
  ...partial,
});

describe('CostSummaryCard', () => {
  it('renders spend / budget / remaining', () => {
    render(<CostSummaryCard summary={mk({})} />);
    expect(screen.getByText(/\$12\.34/)).toBeInTheDocument();
    expect(screen.getByText(/\$50\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\$37\.66/)).toBeInTheDocument();
  });

  it('shows unlimited when budgetUsd is null', () => {
    render(<CostSummaryCard summary={mk({ budgetUsd: null, remainingUsd: null })} />);
    expect(screen.getByText(/unlimited/i)).toBeInTheDocument();
  });

  it('applies red progress bar when ≥80%', () => {
    const { container } = render(<CostSummaryCard summary={mk({ currentMonthSpendUsd: 45, remainingUsd: 5, warningThresholdReached: true })} />);
    expect(container.querySelector('.progress--red')).toBeTruthy();
  });

  it('shows halted banner when halted=true', () => {
    render(<CostSummaryCard summary={mk({ halted: true })} />);
    expect(screen.getByText(/halted/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/web test components/evaluator/CostSummaryCard`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

```tsx
// apps/web/src/components/evaluator/CostSummaryCard.tsx
import type { CostSummary } from '../../types/evaluator';
import { useTranslation } from 'react-i18next';

function fmtUsd(v: number | null): string {
  if (v == null) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(v);
}

export function CostSummaryCard({ summary }: { summary: CostSummary }) {
  const { t } = useTranslation();
  const pct = summary.budgetUsd
    ? Math.min(100, (summary.currentMonthSpendUsd / summary.budgetUsd) * 100)
    : 0;
  const color =
    summary.warningThresholdReached ? 'red'
    : pct >= 50 ? 'yellow'
    : 'green';

  return (
    <section className="cost-summary-card">
      {summary.halted && (
        <div className="banner banner--warn">{t('cost.haltedBanner')}</div>
      )}
      {summary.warningThresholdReached && !summary.halted && (
        <div className="banner banner--warn">{t('cost.approachingBudget')}</div>
      )}

      <div className="cost-summary-card__amount">
        <strong>{fmtUsd(summary.currentMonthSpendUsd)}</strong>
        <span> / {summary.budgetUsd == null ? t('cost.unlimited') : fmtUsd(summary.budgetUsd)}</span>
      </div>

      {summary.budgetUsd != null && (
        <div className={`progress progress--${color}`}>
          <div className="progress__fill" style={{ width: `${pct}%` }} />
        </div>
      )}

      <dl className="cost-summary-card__stats">
        <div>
          <dt>{t('cost.remaining')}</dt>
          <dd>{fmtUsd(summary.remainingUsd)}</dd>
        </div>
        <div>
          <dt>{t('cost.projectedEom')}</dt>
          <dd>{fmtUsd(summary.projectedEndOfMonthUsd)}</dd>
        </div>
      </dl>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/web test components/evaluator/CostSummaryCard`
Expected: 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/evaluator/CostSummaryCard.tsx apps/web/tests/components/evaluator/CostSummaryCard.test.tsx
git commit -m "feat(web): CostSummaryCard with progress bar colour states"
```

### Task 6.2: Cost dashboard page

**Files:**
- Create: `apps/web/src/app/admin/evaluator/costs/page.tsx`
- Create: `apps/web/src/components/evaluator/CostBreakdownTable.tsx`
- Create: `apps/web/src/components/evaluator/HistoricalSpendChart.tsx`

- [ ] **Step 1: CostBreakdownTable**

```tsx
// apps/web/src/components/evaluator/CostBreakdownTable.tsx
import { useTranslation } from 'react-i18next';

interface Row { label: string; calls: number; costUsd: number; }

export function CostBreakdownTable({ title, rows }: { title: string; rows: Row[] }) {
  const { t } = useTranslation();
  return (
    <section>
      <h3>{title}</h3>
      <table className="breakdown-table">
        <thead>
          <tr>
            <th>{t('cost.breakdown.label')}</th>
            <th>{t('cost.breakdown.calls')}</th>
            <th>{t('cost.breakdown.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={3}>{t('cost.breakdown.empty')}</td></tr>
          ) : rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td>{r.calls}</td>
              <td>{new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(r.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 2: HistoricalSpendChart (simple SVG bars)**

```tsx
// apps/web/src/components/evaluator/HistoricalSpendChart.tsx
export function HistoricalSpendChart({ months }: { months: Array<{ month: string; costUsd: number }> }) {
  const max = Math.max(...months.map(m => m.costUsd), 0.01);
  return (
    <svg viewBox="0 0 600 200" className="historical-chart" aria-label="Historical spend">
      {months.map((m, i) => {
        const h = (m.costUsd / max) * 150;
        return (
          <g key={m.month}>
            <rect x={i * 100 + 20} y={180 - h} width={60} height={h} fill="#4a90e2" />
            <text x={i * 100 + 50} y={195} textAnchor="middle" fontSize="10">{m.month}</text>
            <text x={i * 100 + 50} y={180 - h - 4} textAnchor="middle" fontSize="10">
              ${m.costUsd.toFixed(0)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 3: Dashboard page**

```tsx
// apps/web/src/app/admin/evaluator/costs/page.tsx
'use client';

import { trpc } from '../../../../lib/trpc';
import { CostSummaryCard } from '../../../../components/evaluator/CostSummaryCard';
import { CostBreakdownTable } from '../../../../components/evaluator/CostBreakdownTable';
import { HistoricalSpendChart } from '../../../../components/evaluator/HistoricalSpendChart';
import { useTranslation } from 'react-i18next';

export default function CostDashboardPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = trpc.admin.evaluator.cost.getSummary.useQuery();

  if (isLoading) return <p>{t('common.loading')}</p>;
  if (error) return <p role="alert">{error.message}</p>;
  if (!data) return null;

  return (
    <main className="cost-dashboard">
      <h1>{t('cost.title')}</h1>
      <CostSummaryCard summary={data} />

      <div className="cost-dashboard__breakdowns">
        <CostBreakdownTable
          title={t('cost.breakdownByTask')}
          rows={[
            { label: t('cost.facetExtraction'), calls: data.breakdown.facetExtraction.calls, costUsd: data.breakdown.facetExtraction.costUsd },
            { label: t('cost.deepAnalysis'), calls: data.breakdown.deepAnalysis.calls, costUsd: data.breakdown.deepAnalysis.costUsd },
          ]}
        />
        <CostBreakdownTable
          title={t('cost.breakdownByModel')}
          rows={data.breakdownByModel.map(m => ({ label: m.model, calls: m.calls, costUsd: m.costUsd }))}
        />
      </div>

      <section>
        <h2>{t('cost.historical')}</h2>
        <HistoricalSpendChart months={data.historicalMonths} />
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Add i18n keys** for `cost.*` in all 3 locale JSON files.

- [ ] **Step 5: Manual smoke**

Start dev server, log in as admin, visit `/admin/evaluator/costs`, verify page renders with real data.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/admin/evaluator/costs/ apps/web/src/components/evaluator/CostBreakdownTable.tsx apps/web/src/components/evaluator/HistoricalSpendChart.tsx apps/web/src/i18n/
git commit -m "feat(web): cost dashboard page with breakdowns and historical chart"
```

### Task 6.3: Admin home widget

**Files:**
- Modify: `apps/web/src/app/admin/page.tsx`
- Create: `apps/web/src/components/admin/CostWidget.tsx`

- [ ] **Step 1: Create widget**

```tsx
// apps/web/src/components/admin/CostWidget.tsx
'use client';

import Link from 'next/link';
import { trpc } from '../../lib/trpc';
import { useTranslation } from 'react-i18next';

export function CostWidget() {
  const { t } = useTranslation();
  const { data } = trpc.admin.evaluator.cost.getSummary.useQuery(undefined, { retry: false });
  if (!data) return null;

  const pct = data.budgetUsd ? (data.currentMonthSpendUsd / data.budgetUsd) * 100 : 0;

  return (
    <Link href="/admin/evaluator/costs" className="cost-widget">
      <div className="cost-widget__amount">
        ${data.currentMonthSpendUsd.toFixed(2)}
        {data.budgetUsd != null && <> / ${data.budgetUsd.toFixed(2)}</>}
      </div>
      {data.budgetUsd != null && (
        <div className={`progress progress--${data.warningThresholdReached ? 'red' : pct >= 50 ? 'yellow' : 'green'}`}>
          <div className="progress__fill" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
      <span className="cost-widget__label">{t('cost.thisMonth')}</span>
    </Link>
  );
}
```

- [ ] **Step 2: Wire into admin home**

Modify `apps/web/src/app/admin/page.tsx`, import and render `<CostWidget />` alongside existing widgets.

- [ ] **Step 3: Manual smoke**

Visit `/admin`, verify widget appears; click, verify navigation to `/admin/evaluator/costs`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/admin/CostWidget.tsx apps/web/src/app/admin/page.tsx
git commit -m "feat(web): CostWidget on admin home linking to cost dashboard"
```

---

## Part 7 — New Prometheus metrics

### Task 7.1: Register new counters and histogram

**Files:**
- Modify: `apps/gateway/src/metrics/index.ts`
- Test: `apps/gateway/tests/metrics/newCounters.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/gateway/tests/metrics/newCounters.test.ts
import { describe, it, expect } from 'vitest';
import {
  gwFacetExtractTotal,
  gwFacetExtractDurationMs,
  gwFacetCacheHitTotal,
  gwLlmCostUsdTotal,
  gwLlmBudgetWarnTotal,
  gwLlmBudgetExceededTotal,
} from '../../src/metrics';

describe('new Plan 4C metrics', () => {
  it('gw_facet_extract_total counter accepts org_id + result labels', async () => {
    gwFacetExtractTotal.inc({ org_id: 'o', result: 'success' });
    const json = await gwFacetExtractTotal.get();
    expect(json.values[0].labels).toEqual({ org_id: 'o', result: 'success' });
    expect(json.values[0].value).toBe(1);
  });

  it('gw_facet_extract_duration_ms is a histogram', async () => {
    gwFacetExtractDurationMs.observe({ org_id: 'o' }, 1234);
    const json = await gwFacetExtractDurationMs.get();
    expect(json.type).toBe('histogram');
  });

  it('gw_llm_cost_usd_total accepts org_id + event_type + model', async () => {
    gwLlmCostUsdTotal.inc({ org_id: 'o', event_type: 'facet_extraction', model: 'claude-haiku-4-5' }, 0.01);
    const json = await gwLlmCostUsdTotal.get();
    expect(json.values[0].value).toBe(0.01);
  });

  it('gw_llm_budget_exceeded_total accepts behavior label', async () => {
    gwLlmBudgetExceededTotal.inc({ org_id: 'o', behavior: 'degrade' });
    gwLlmBudgetExceededTotal.inc({ org_id: 'o', behavior: 'halt' });
    const json = await gwLlmBudgetExceededTotal.get();
    expect(json.values).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/gateway test metrics/newCounters`
Expected: FAIL (undefined exports)

- [ ] **Step 3: Add metrics**

Append to `apps/gateway/src/metrics/index.ts`:

```typescript
import { Counter, Histogram } from 'prom-client';
import { register } from './registry';

export const gwFacetExtractTotal = new Counter({
  name: 'gw_facet_extract_total',
  help: 'Total facet extraction attempts',
  labelNames: ['org_id', 'result'] as const,
  registers: [register],
});

export const gwFacetExtractDurationMs = new Histogram({
  name: 'gw_facet_extract_duration_ms',
  help: 'Facet extraction LLM call duration in ms',
  labelNames: ['org_id'] as const,
  buckets: [100, 250, 500, 1000, 2500, 5000, 10000, 15000],
  registers: [register],
});

export const gwFacetCacheHitTotal = new Counter({
  name: 'gw_facet_cache_hit_total',
  help: 'Sessions that reused an existing facet (cache hit)',
  labelNames: ['org_id'] as const,
  registers: [register],
});

export const gwLlmCostUsdTotal = new Counter({
  name: 'gw_llm_cost_usd_total',
  help: 'Cumulative LLM cost in USD',
  labelNames: ['org_id', 'event_type', 'model'] as const,
  registers: [register],
});

export const gwLlmBudgetWarnTotal = new Counter({
  name: 'gw_llm_budget_warn_total',
  help: 'Times an evaluation emitted a budget warning (spend ≥ 80% budget)',
  labelNames: ['org_id'] as const,
  registers: [register],
});

export const gwLlmBudgetExceededTotal = new Counter({
  name: 'gw_llm_budget_exceeded_total',
  help: 'Times a budget throw occurred',
  labelNames: ['org_id', 'behavior'] as const,
  registers: [register],
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/gateway test metrics/newCounters`
Expected: 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/metrics/index.ts apps/gateway/tests/metrics/newCounters.test.ts
git commit -m "feat(gateway): register Plan 4C metrics (facet + LLM cost)"
```

### Task 7.2: Emit metrics from callWithCostTracking

**Files:**
- Modify: `apps/gateway/src/workers/evaluator/ledgerWriter.ts` (wrap with metric emission)
- Modify: `apps/gateway/src/workers/evaluator/budgetDeps.ts` (emit budget warn/exceeded)

- [ ] **Step 1: Modify ledgerWriter to emit cost metric**

```typescript
// apps/gateway/src/workers/evaluator/ledgerWriter.ts
import type { Pool } from 'pg';
import type { LedgerRow } from '@aide/evaluator/llm/callWithCostTracking';
import { gwLlmCostUsdTotal } from '../../metrics';

export function createLedgerWriter(db: Pool): (row: LedgerRow) => Promise<void> {
  return async (row) => {
    await db.query(
      `INSERT INTO llm_usage_events
         (org_id, event_type, model, tokens_input, tokens_output, cost_usd, ref_type, ref_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.orgId, row.eventType, row.model, row.tokensInput, row.tokensOutput, row.costUsd, row.refType ?? null, row.refId ?? null],
    );
    gwLlmCostUsdTotal.inc(
      { org_id: row.orgId, event_type: row.eventType, model: row.model },
      row.costUsd,
    );
  };
}
```

- [ ] **Step 2: Wrap enforceBudget to emit warn/exceeded**

Create `apps/gateway/src/workers/evaluator/enforceBudgetWithMetrics.ts`:

```typescript
import { enforceBudget, EnforceBudgetDeps } from '@aide/evaluator/budget/enforceBudget';
import { BudgetExceededDegrade, BudgetExceededHalt } from '@aide/evaluator/budget/errors';
import { gwLlmBudgetWarnTotal, gwLlmBudgetExceededTotal } from '../../metrics';

export function wrapEnforceBudget(deps: EnforceBudgetDeps) {
  return async (orgId: string, estimatedCost: number): Promise<void> => {
    try {
      await enforceBudget(orgId, estimatedCost, deps);

      const org = await deps.loadOrg(orgId);
      if (org.llm_monthly_budget_usd != null) {
        const spend = await deps.getMonthSpend(orgId, monthStartUtc(deps.now()));
        if (spend >= org.llm_monthly_budget_usd * 0.8) {
          gwLlmBudgetWarnTotal.inc({ org_id: orgId });
        }
      }
    } catch (e) {
      if (e instanceof BudgetExceededDegrade) {
        gwLlmBudgetExceededTotal.inc({ org_id: orgId, behavior: 'degrade' });
      } else if (e instanceof BudgetExceededHalt) {
        gwLlmBudgetExceededTotal.inc({ org_id: orgId, behavior: 'halt' });
      }
      throw e;
    }
  };
}

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
```

- [ ] **Step 3: Write integration test confirming metrics fire**

Create `apps/gateway/tests/workers/evaluator/enforceBudgetMetrics.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { wrapEnforceBudget } from '../../../src/workers/evaluator/enforceBudgetWithMetrics';
import { createBudgetDeps } from '../../../src/workers/evaluator/budgetDeps';
import { gwLlmBudgetExceededTotal, gwLlmBudgetWarnTotal } from '../../../src/metrics';
import { getTestDb, seedOrg } from '../../helpers/db';

describe('budget metrics', () => {
  const db = getTestDb();
  let orgId: string;
  beforeEach(async () => {
    await db.query('TRUNCATE organizations, llm_usage_events CASCADE');
    orgId = await seedOrg(db, { llm_monthly_budget_usd: 10, llm_budget_overage_behavior: 'degrade' });
  });

  it('emits warn metric at 80% spend', async () => {
    await db.query(
      `INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd)
       VALUES ($1, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 8.0)`, [orgId],
    );
    const before = (await gwLlmBudgetWarnTotal.get()).values.find(v => v.labels.org_id === orgId)?.value ?? 0;
    const enforce = wrapEnforceBudget(createBudgetDeps(db));
    await enforce(orgId, 0.5);
    const after = (await gwLlmBudgetWarnTotal.get()).values.find(v => v.labels.org_id === orgId)?.value ?? 0;
    expect(after - before).toBe(1);
  });

  it('emits exceeded metric on degrade', async () => {
    await db.query(
      `INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd)
       VALUES ($1, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 9.99)`, [orgId],
    );
    const before = (await gwLlmBudgetExceededTotal.get()).values.find(v => v.labels.org_id === orgId && v.labels.behavior === 'degrade')?.value ?? 0;
    const enforce = wrapEnforceBudget(createBudgetDeps(db));
    await expect(enforce(orgId, 1.0)).rejects.toThrow();
    const after = (await gwLlmBudgetExceededTotal.get()).values.find(v => v.labels.org_id === orgId && v.labels.behavior === 'degrade')?.value ?? 0;
    expect(after - before).toBe(1);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @aide/gateway test workers/evaluator/enforceBudgetMetrics`
Expected: 2 tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/workers/evaluator/ledgerWriter.ts apps/gateway/src/workers/evaluator/enforceBudgetWithMetrics.ts apps/gateway/tests/workers/evaluator/enforceBudgetMetrics.integration.test.ts
git commit -m "feat(gateway): emit budget warn/exceeded + cost metrics"
```

---

## Part 8 — Grafana dashboards

### Task 8.1: evaluator.json dashboard

**Files:**
- Create: `ops/grafana/evaluator.json`

- [ ] **Step 1: Write dashboard JSON**

```json
{
  "uid": "aide-evaluator",
  "title": "AIDE — Evaluator",
  "schemaVersion": 39,
  "timezone": "utc",
  "refresh": "1m",
  "tags": ["aide", "evaluator"],
  "templating": {
    "list": [
      {
        "name": "org_id",
        "type": "query",
        "datasource": "Prometheus",
        "query": "label_values(gw_eval_job_completed_total, org_id)",
        "includeAll": true,
        "allValue": ".*"
      }
    ]
  },
  "panels": [
    {
      "title": "Jobs — rate completed vs failed",
      "type": "timeseries",
      "targets": [
        { "expr": "sum(rate(gw_eval_job_completed_total{org_id=~\"$org_id\"}[5m]))", "legendFormat": "completed" },
        { "expr": "sum(rate(gw_eval_job_failed_total{org_id=~\"$org_id\"}[5m]))", "legendFormat": "failed" }
      ]
    },
    {
      "title": "Job duration p50/p99",
      "type": "timeseries",
      "targets": [
        { "expr": "histogram_quantile(0.50, rate(gw_eval_job_duration_ms_bucket{org_id=~\"$org_id\"}[5m]))", "legendFormat": "p50" },
        { "expr": "histogram_quantile(0.99, rate(gw_eval_job_duration_ms_bucket{org_id=~\"$org_id\"}[5m]))", "legendFormat": "p99" }
      ]
    },
    {
      "title": "DLQ depth (24h)",
      "type": "timeseries",
      "targets": [
        { "expr": "gw_eval_dlq_depth{org_id=~\"$org_id\"}", "legendFormat": "{{org_id}}" }
      ]
    },
    {
      "title": "Facet extraction result breakdown",
      "type": "timeseries",
      "targets": [
        { "expr": "sum by (result) (rate(gw_facet_extract_total{org_id=~\"$org_id\"}[5m]))", "legendFormat": "{{result}}" }
      ]
    },
    {
      "title": "Facet cache hit rate",
      "type": "stat",
      "targets": [
        { "expr": "sum(rate(gw_facet_cache_hit_total{org_id=~\"$org_id\"}[1h])) / (sum(rate(gw_facet_cache_hit_total{org_id=~\"$org_id\"}[1h])) + sum(rate(gw_facet_extract_total{org_id=~\"$org_id\"}[1h])))" }
      ]
    },
    {
      "title": "Facet extraction duration heatmap",
      "type": "heatmap",
      "targets": [
        { "expr": "sum by (le) (rate(gw_facet_extract_duration_ms_bucket{org_id=~\"$org_id\"}[5m]))" }
      ]
    },
    {
      "title": "LLM spend this month by org",
      "type": "bargauge",
      "targets": [
        { "expr": "sum by (org_id) (increase(gw_llm_cost_usd_total[30d]))", "legendFormat": "{{org_id}}" }
      ]
    },
    {
      "title": "Top 5 spenders (30d)",
      "type": "table",
      "targets": [
        { "expr": "topk(5, sum by (org_id) (increase(gw_llm_cost_usd_total[30d])))" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Validate JSON**

Run: `jq empty ops/grafana/evaluator.json`
Expected: no output (valid JSON)

- [ ] **Step 3: Commit**

```bash
git add ops/grafana/evaluator.json
git commit -m "feat(ops): grafana dashboard for evaluator subsystem"
```

### Task 8.2: body-capture.json and gdpr.json dashboards

**Files:**
- Create: `ops/grafana/body-capture.json`
- Create: `ops/grafana/gdpr.json`

- [ ] **Step 1: body-capture.json**

```json
{
  "uid": "aide-body-capture",
  "title": "AIDE — Body Capture",
  "schemaVersion": 39,
  "timezone": "utc",
  "refresh": "1m",
  "tags": ["aide", "body-capture"],
  "panels": [
    { "title": "Capture rate", "type": "timeseries",
      "targets": [{ "expr": "sum(rate(gw_body_captured_total[5m]))" }] },
    { "title": "Purge lag hours", "type": "timeseries",
      "targets": [{ "expr": "gw_body_purge_lag_hours" }] },
    { "title": "Encryption throughput (bytes/s)", "type": "timeseries",
      "targets": [{ "expr": "sum(rate(gw_body_encryption_bytes_total[5m]))" }] },
    { "title": "Body size distribution", "type": "heatmap",
      "targets": [{ "expr": "sum by (le) (rate(gw_body_size_bytes_bucket[5m]))" }] }
  ]
}
```

- [ ] **Step 2: gdpr.json**

```json
{
  "uid": "aide-gdpr",
  "title": "AIDE — GDPR",
  "schemaVersion": 39,
  "timezone": "utc",
  "refresh": "5m",
  "tags": ["aide", "gdpr"],
  "panels": [
    { "title": "Pending requests", "type": "stat",
      "targets": [{ "expr": "gw_gdpr_pending_requests" }] },
    { "title": "Requests > 25 days old (SLA red zone)", "type": "stat",
      "targets": [{ "expr": "sum(gw_gdpr_request_age_days > 25)" }] },
    { "title": "Executor cron success rate (24h)", "type": "stat",
      "targets": [{ "expr": "sum(rate(gw_gdpr_executor_success_total[24h])) / sum(rate(gw_gdpr_executor_runs_total[24h]))" }] }
  ]
}
```

- [ ] **Step 3: Validate both**

Run: `jq empty ops/grafana/body-capture.json ops/grafana/gdpr.json`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add ops/grafana/body-capture.json ops/grafana/gdpr.json
git commit -m "feat(ops): grafana dashboards for body capture + GDPR"
```

---

## Part 9 — Alert rules + Alertmanager template

### Task 9.1: Prometheus alert rules

**Files:**
- Create: `ops/prometheus/alerts.yml`
- Test: `ops/prometheus/alerts.test.sh`

- [ ] **Step 1: Write alerts.yml**

```yaml
# ops/prometheus/alerts.yml
groups:
- name: aide-evaluator
  rules:
  - alert: EvaluatorDLQBacklog
    expr: gw_eval_dlq_depth > 10
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "Evaluator DLQ has more than 10 entries"
      runbook: "docs/runbooks/evaluator-dlq.md"
      dashboard: "grafana/d/aide-evaluator"
  - alert: EvaluatorDLQCritical
    expr: gw_eval_dlq_depth > 50
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Evaluator DLQ backlog >50 for 5min"
      runbook: "docs/runbooks/evaluator-dlq.md"
  - alert: EvaluatorCronNotFiring
    expr: absent(gw_eval_cron_fired_total) or increase(gw_eval_cron_fired_total[25h]) < 1
    labels:
      severity: critical
    annotations:
      summary: "Evaluator cron has not fired in the last 25h"
      runbook: "docs/runbooks/evaluator-cron.md"
  - alert: FacetExtractionFailureRate
    expr: |
      sum(rate(gw_facet_extract_total{result!="success"}[15m]))
        / sum(rate(gw_facet_extract_total[15m])) > 0.3
    for: 30m
    labels:
      severity: warning
    annotations:
      summary: "Facet extraction failure rate >30% for 30min"
      runbook: "docs/runbooks/facet-extraction.md"

- name: aide-body-capture
  rules:
  - alert: BodyPurgeLagging
    expr: gw_body_purge_lag_hours > 6
    for: 30m
    labels:
      severity: warning
    annotations:
      summary: "Body purge lag >6h"
      runbook: "docs/runbooks/body-purge-lag.md"

- name: aide-gdpr
  rules:
  - alert: GDPRSLANearing
    expr: max(gw_gdpr_request_age_days) > 25
    labels:
      severity: warning
    annotations:
      summary: "GDPR request older than 25 days (SLA 30)"
      runbook: "docs/runbooks/gdpr-sla.md"
  - alert: GDPRSLAViolated
    expr: max(gw_gdpr_request_age_days) > 30
    labels:
      severity: critical
    annotations:
      summary: "GDPR request >30 days — SLA violated"
      runbook: "docs/runbooks/gdpr-sla.md"

- name: aide-llm-cost
  rules:
  - alert: LLMBudgetWarning
    expr: rate(gw_llm_budget_warn_total[1h]) > 0
    labels:
      severity: info
    annotations:
      summary: "An org crossed 80% of monthly LLM budget"
      runbook: "docs/runbooks/llm-budget.md"
  - alert: LLMBudgetExceeded
    expr: rate(gw_llm_budget_exceeded_total[1h]) > 0
    labels:
      severity: warning
    annotations:
      summary: "An org exceeded monthly LLM budget"
      runbook: "docs/runbooks/llm-budget.md"
```

- [ ] **Step 2: Promtool validation**

Create `ops/prometheus/alerts.test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
# Requires: docker or a local promtool binary
docker run --rm -v "$(pwd)/ops/prometheus:/w" prom/prometheus:v2.54.0 \
  promtool check rules /w/alerts.yml
```

- [ ] **Step 3: Run validation**

Run: `bash ops/prometheus/alerts.test.sh`
Expected: `SUCCESS: N rules found`

- [ ] **Step 4: Commit**

```bash
git add ops/prometheus/alerts.yml ops/prometheus/alerts.test.sh
git commit -m "feat(ops): prometheus alert rules (DLQ, purge, GDPR, LLM budget, facet)"
```

### Task 9.2: Alertmanager example template

**Files:**
- Create: `ops/alertmanager/alertmanager.yml.example`

- [ ] **Step 1: Write example**

```yaml
# ops/alertmanager/alertmanager.yml.example
# Copy to alertmanager.yml (gitignored) and fill in your webhook URLs.
global:
  resolve_timeout: 5m

route:
  receiver: default
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  routes:
    - matchers: [severity="critical"]
      receiver: critical
      continue: true
    - matchers: [severity="warning"]
      receiver: warnings

receivers:
  - name: default
    webhook_configs:
      - url: "REPLACE_WITH_YOUR_WEBHOOK_URL"
  - name: critical
    # Example: Slack / PagerDuty / Opsgenie
    webhook_configs:
      - url: "REPLACE_WITH_CRITICAL_WEBHOOK_URL"
  - name: warnings
    webhook_configs:
      - url: "REPLACE_WITH_WARNINGS_WEBHOOK_URL"
```

- [ ] **Step 2: Commit**

```bash
git add ops/alertmanager/alertmanager.yml.example
git commit -m "feat(ops): alertmanager example template (webhook placeholders)"
```

---

## Part 10 — Runbooks (8 files)

### Task 10.1: Runbook template

**Files:**
- Create `docs/runbooks/_template.md`

- [ ] **Step 1: Write template**

```markdown
# <Alert Name>

## Severity
<warning | critical | info>

## Symptoms
- What does the operator see? (dashboard panels going red, user reports, etc.)

## Likely causes
1. Cause 1 …
2. Cause 2 …

## Diagnosis commands
\`\`\`bash
# Example diagnostic commands
\`\`\`

## Resolution steps
1. Step 1 …
2. Step 2 …

## Escalation
- If resolution steps fail after N minutes, page on-call / open GitHub issue labelled `release-blocker`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/_template.md
git commit -m "docs(runbooks): template for alert runbooks"
```

### Task 10.2: evaluator-dlq.md

**Files:**
- Create: `docs/runbooks/evaluator-dlq.md`

- [ ] **Step 1: Write runbook**

```markdown
# Evaluator DLQ Backlog

## Severity
warning (>10 for 15m), critical (>50 for 5m)

## Symptoms
- `gw_eval_dlq_depth` > 10 on evaluator dashboard
- Members see stale reports; admin dashboard shows no recent reports

## Likely causes
1. Upstream Anthropic outage causing repeated job failures
2. DB connectivity issue preventing job completion
3. Bug in evaluator worker (check recent deploys)
4. Budget enforcement preventing completion

## Diagnosis commands
\`\`\`bash
# Inspect top 10 DLQ jobs
docker exec aide-redis redis-cli LRANGE bull:evaluator:failed 0 10

# Check worker logs
docker logs aide-gateway --since 30m | grep evaluator

# Check recent deploys
git log --oneline -20 apps/gateway/src/workers/evaluator/
\`\`\`

## Resolution steps
1. If Anthropic outage: wait; DLQ will self-drain via retry schedule. Set `ENABLE_FACET_EXTRACTION=false` if cascading.
2. If DB error: check connection pool saturation; restart gateway if stuck.
3. If bug: roll back last deploy (`docker pull ghcr.io/hanfour/aide-gateway:v<prev>` + restart).
4. Manually re-queue drained jobs: `pnpm --filter @aide/gateway exec node scripts/requeue-dlq.ts`.

## Escalation
- >30 min with backlog still growing: open GitHub issue `release-blocker` and page admin.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/evaluator-dlq.md
git commit -m "docs(runbooks): evaluator DLQ backlog"
```

### Task 10.3: Remaining 7 runbooks

**Files:**
- Create: `docs/runbooks/body-purge-lag.md`
- Create: `docs/runbooks/gdpr-sla.md`
- Create: `docs/runbooks/llm-budget.md`
- Create: `docs/runbooks/facet-extraction.md`
- Create: `docs/runbooks/evaluator-cron.md`
- Create: `docs/runbooks/facet-parse-errors.md`
- Create: `docs/runbooks/cost-ledger-mismatch.md`

- [ ] **Step 1: body-purge-lag.md**

```markdown
# Body Purge Lag

## Severity
warning

## Symptoms
- `gw_body_purge_lag_hours` > 6

## Likely causes
1. Purge cron (4h interval) failed; check gateway logs
2. DB lock contention on `request_bodies`
3. High body volume exceeds purge throughput

## Diagnosis commands
\`\`\`bash
docker logs aide-gateway --since 6h | grep -i "body_purge\|purge_cron"
psql $DATABASE_URL -c "SELECT COUNT(*) FROM request_bodies WHERE expires_at < now();"
\`\`\`

## Resolution steps
1. Manually run purge: `pnpm --filter @aide/gateway exec node scripts/run-body-purge.ts`
2. If lock contention: off-peak schedule; consider chunked deletes.

## Escalation
- Lag >24h: likely data-retention compliance issue; notify ops lead.
```

- [ ] **Step 2: gdpr-sla.md**

```markdown
# GDPR SLA

## Severity
warning (>25 days), critical (>30 days)

## Symptoms
- `gw_gdpr_request_age_days` > 25

## Likely causes
1. Admin queue has unreviewed requests (notification missed)
2. Executor cron failing silently
3. Request stuck in `approved` but not executed

## Diagnosis commands
\`\`\`bash
psql $DATABASE_URL -c "SELECT id, status, created_at, now() - created_at AS age FROM gdpr_delete_requests WHERE status IN ('pending','approved') ORDER BY created_at ASC LIMIT 20;"
docker logs aide-gateway --since 24h | grep gdpr_executor
\`\`\`

## Resolution steps
1. For `pending`: notify org admin immediately.
2. For `approved`: trigger executor manually: `pnpm --filter @aide/gateway exec node scripts/run-gdpr-executor.ts --id <uuid>`.

## Escalation
- >30 days: legal/compliance risk — notify ops lead + legal.
```

- [ ] **Step 3: llm-budget.md**

```markdown
# LLM Budget Warning / Exceeded

## Severity
info (warning), warning (exceeded)

## Symptoms
- Admin dashboard shows red progress bar
- `gw_llm_budget_warn_total` or `gw_llm_budget_exceeded_total` incrementing

## Likely causes
1. Legitimate high evaluation volume
2. Misconfigured `llm_eval_model` to opus
3. Runaway facet extraction loop (bug)

## Diagnosis commands
\`\`\`bash
psql $DATABASE_URL -c "SELECT event_type, model, SUM(cost_usd) FROM llm_usage_events WHERE org_id = '<id>' AND created_at >= date_trunc('month', now()) GROUP BY 1,2 ORDER BY 3 DESC;"
\`\`\`

## Resolution steps
1. Verify spend pattern matches expected volume.
2. If misconfig: admin changes model in Settings.
3. If bug: set `ENABLE_FACET_EXTRACTION=false` and investigate.

## Escalation
- Repeated overage: suggest budget increase or tighter model choice.
```

- [ ] **Step 4: facet-extraction.md**

```markdown
# Facet Extraction Failure Rate

## Severity
warning

## Symptoms
- Failure rate >30% for 30 minutes on `gw_facet_extract_total{result!="success"}`

## Likely causes
1. Prompt regression (recent change to promptBuilder)
2. Anthropic model returning unexpected format
3. Session content too large, hitting truncation bugs

## Diagnosis commands
\`\`\`bash
psql $DATABASE_URL -c "SELECT extraction_error, COUNT(*) FROM request_body_facets WHERE extracted_at > now() - interval '1h' AND extraction_error IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;"
\`\`\`

## Resolution steps
1. If parse_error dominant: examine LLM responses; may need prompt_version bump.
2. If validation_error: schema mismatch; check parser.ts.
3. If timeout: session bodies too large; adjust truncation.

## Escalation
- If >50% for 1h: disable facet extraction via `ENABLE_FACET_EXTRACTION=false`.
```

- [ ] **Step 5: evaluator-cron.md**

```markdown
# Evaluator Cron Not Firing

## Severity
critical

## Symptoms
- `gw_eval_cron_fired_total` absent OR no increase in 25h

## Likely causes
1. Gateway container restarted and cron didn't re-register
2. Redis connection lost
3. BullMQ scheduler bug

## Diagnosis commands
\`\`\`bash
docker ps | grep aide-gateway
docker logs aide-gateway --since 26h | grep -i "cron\|scheduler"
docker exec aide-redis redis-cli KEYS "bull:evaluator:*"
\`\`\`

## Resolution steps
1. Restart gateway: `docker restart aide-gateway`.
2. Verify cron registration in logs.
3. If still failing, manually trigger: `curl -X POST http://gateway:3000/internal/evaluator/trigger`.

## Escalation
- Reports are silently missing; announce to users if downtime >24h.
```

- [ ] **Step 6: facet-parse-errors.md**

```markdown
# Facet Parse Errors (Deep Dive)

## Severity
informational (companion to facet-extraction.md)

## Symptoms
- `extraction_error` starts with `parse_error` or `validation_error` on many rows

## Likely causes
1. Anthropic model drift (rare; happens around version migrations)
2. Prompt encourages prose instead of JSON
3. Session content contains adversarial JSON that fools the parser

## Diagnosis commands
\`\`\`bash
psql $DATABASE_URL -c "SELECT extraction_error FROM request_body_facets WHERE extraction_error LIKE 'parse_error%' ORDER BY extracted_at DESC LIMIT 10;"
\`\`\`

## Resolution steps
1. Read 10 failing samples; look for common pattern.
2. Adjust prompt or parser fallback strategies.
3. Bump `CURRENT_PROMPT_VERSION` to force re-extraction after fix.

## Escalation
- Regression persists >24h: roll back facet_model to previous choice.
```

- [ ] **Step 7: cost-ledger-mismatch.md**

```markdown
# Cost Ledger vs Bill Mismatch

## Severity
warning

## Symptoms
- Anthropic bill differs from `SUM(llm_usage_events.cost_usd)` by >5%

## Likely causes
1. Pricing table in `packages/evaluator/src/llm/pricing.ts` out of date
2. Usage reported by Anthropic differs from internal assumption
3. Ledger writes failing silently

## Diagnosis commands
\`\`\`bash
psql $DATABASE_URL -c "SELECT to_char(created_at, 'YYYY-MM') AS m, SUM(cost_usd) FROM llm_usage_events GROUP BY 1 ORDER BY 1 DESC LIMIT 3;"
# Compare to Anthropic console billing for same month.
\`\`\`

## Resolution steps
1. Diff Anthropic's published pricing vs `PRICING` const. If pricing changed: update table + PR.
2. Check gateway logs for `insertLedger` errors.
3. For persistent drift: add per-call detail logging; consider `llm_usage_events` → ETL to Anthropic usage API for reconciliation.

## Escalation
- >10% mismatch: suspect ledger write failures; treat as incident.
```

- [ ] **Step 8: Commit all 7**

```bash
git add docs/runbooks/body-purge-lag.md docs/runbooks/gdpr-sla.md docs/runbooks/llm-budget.md docs/runbooks/facet-extraction.md docs/runbooks/evaluator-cron.md docs/runbooks/facet-parse-errors.md docs/runbooks/cost-ledger-mismatch.md
git commit -m "docs(runbooks): 7 remaining alert runbooks"
```

---

## Part 11 — Post-release smoke workflow

### Task 11.1: Extend smoke-evaluator.sh

**Files:**
- Modify: `scripts/smoke-evaluator.sh`

- [ ] **Step 1: Inspect existing smoke script**

Run: `cat scripts/smoke-evaluator.sh`

- [ ] **Step 2: Add report-verification step**

Append to the script (after existing tRPC call):

```bash
# --- v0.5.0: verify cost summary tRPC returns well-formed data ---
echo "→ Verifying cost summary endpoint"
cost_resp=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${CANARY_SERVICE_TOKEN}" \
  -d '{}' \
  "${CANARY_URL}/trpc/admin.evaluator.cost.getSummary")

echo "$cost_resp" | jq -e '.result.data | has("currentMonthSpendUsd")' > /dev/null \
  || { echo "FAIL: cost summary missing currentMonthSpendUsd"; exit 1; }

echo "→ Cost summary OK"
```

- [ ] **Step 3: Make executable and test locally**

Run: `chmod +x scripts/smoke-evaluator.sh && CANARY_URL=http://localhost:3000 CANARY_SERVICE_TOKEN=test bash scripts/smoke-evaluator.sh`
Expected: exits 0 if local gateway is running; otherwise clear error.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-evaluator.sh
git commit -m "feat(scripts): smoke-evaluator.sh verifies cost summary endpoint"
```

### Task 11.2: Canary env template

**Files:**
- Create: `ops/canary-org.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Write example**

```bash
# ops/canary-org.env.example
# Copy to ops/canary-org.env (gitignored) and fill in real values for your canary org.
CANARY_URL=https://your-prod-url.example.com
CANARY_ORG_ID=00000000-0000-0000-0000-000000000000
CANARY_SERVICE_TOKEN=replace-with-service-account-token
CANARY_ADMIN_EMAIL=admin@example.com
```

- [ ] **Step 2: Add to gitignore**

Append to `.gitignore`:

```
ops/canary-org.env
ops/alertmanager/alertmanager.yml
```

- [ ] **Step 3: Commit**

```bash
git add ops/canary-org.env.example .gitignore
git commit -m "feat(ops): canary-org.env.example + gitignore real secrets"
```

### Task 11.3: Post-release smoke E2E spec

**Files:**
- Create: `apps/web/e2e/specs/99-post-release-smoke.spec.ts`

- [ ] **Step 1: Write spec**

```typescript
// apps/web/e2e/specs/99-post-release-smoke.spec.ts
import { test, expect } from '@playwright/test';

test.describe('post-release smoke (canary org)', () => {
  test('admin loads cost dashboard', async ({ page }) => {
    const url = process.env.CANARY_URL;
    const token = process.env.CANARY_SERVICE_TOKEN;
    if (!url || !token) test.skip(true, 'Canary env not configured');

    // Use service token via cookie/header as appropriate for your auth
    await page.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
    await page.goto(`${url}/admin/evaluator/costs`);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Cost summary card renders the dollar amount
    await expect(page.locator('.cost-summary-card__amount')).toBeVisible();
  });

  test('admin loads reports list', async ({ page }) => {
    const url = process.env.CANARY_URL;
    const token = process.env.CANARY_SERVICE_TOKEN;
    if (!url || !token) test.skip(true, 'Canary env not configured');

    await page.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
    await page.goto(`${url}/admin/evaluator/reports`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/e2e/specs/99-post-release-smoke.spec.ts
git commit -m "test(e2e): post-release smoke spec for canary org"
```

### Task 11.4: GitHub Actions post-release-smoke workflow

**Files:**
- Create: `.github/workflows/post-release-smoke.yml`

- [ ] **Step 1: Write workflow**

```yaml
# .github/workflows/post-release-smoke.yml
name: Post-release smoke

on:
  workflow_run:
    workflows: [Release]
    types: [completed]
  workflow_dispatch:

jobs:
  smoke:
    if: ${{ github.event.workflow_run.conclusion == 'success' || github.event_name == 'workflow_dispatch' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v3
        with: { version: 9 }

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @aide/web exec playwright install --with-deps chromium

      - name: Run smoke-evaluator.sh
        env:
          CANARY_URL: ${{ secrets.CANARY_URL }}
          CANARY_SERVICE_TOKEN: ${{ secrets.CANARY_SERVICE_TOKEN }}
        run: bash scripts/smoke-evaluator.sh

      - name: Run Playwright smoke spec
        env:
          CANARY_URL: ${{ secrets.CANARY_URL }}
          CANARY_SERVICE_TOKEN: ${{ secrets.CANARY_SERVICE_TOKEN }}
        run: pnpm --filter @aide/web exec playwright test e2e/specs/99-post-release-smoke.spec.ts

      - name: On failure — create issue
        if: failure()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          TAG="${{ github.event.workflow_run.head_branch || 'manual' }}"
          gh issue create \
            --title "Post-release smoke failed: $TAG" \
            --body "Workflow run: ${{ github.event.workflow_run.html_url }}

          Please investigate. This is a release-blocker." \
            --label release-blocker
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/post-release-smoke.yml
git commit -m "ci: post-release smoke workflow (auto-issue on failure)"
```

---

## Part 12 — SSE integration test + arm64 matrix change

### Task 12.1: MSW Anthropic SSE handler

**Files:**
- Create: `apps/gateway/tests/msw/anthropicSse.ts`

- [ ] **Step 1: Write SSE handler**

```typescript
// apps/gateway/tests/msw/anthropicSse.ts
import { http, HttpResponse } from 'msw';

export interface SseScript {
  chunks: Array<string>;
  delayMs?: number;
}

export function sseEvent(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function happyTextScript(): SseScript {
  return {
    chunks: [
      sseEvent('message_start', { message: { id: 'msg_1', role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 100, output_tokens: 0 } } }),
      sseEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
      sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' world' } }),
      sseEvent('content_block_stop', { index: 0 }),
      sseEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }),
      sseEvent('message_stop', {}),
    ],
  };
}

export function toolUseSplitScript(): SseScript {
  return {
    chunks: [
      sseEvent('message_start', { message: { id: 'msg_2', role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 50, output_tokens: 0 } } }),
      sseEvent('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'read', input: {} } }),
      sseEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"pa' } }),
      sseEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'th":' } }),
      sseEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"a.t' } }),
      sseEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'xt"' } }),
      sseEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '}' } }),
      sseEvent('content_block_stop', { index: 0 }),
      sseEvent('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } }),
      sseEvent('message_stop', {}),
    ],
  };
}

export function createAnthropicSseHandler(script: SseScript) {
  return http.post('*/v1/messages', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (const chunk of script.chunks) {
          if (script.delayMs) await new Promise(r => setTimeout(r, script.delayMs));
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new HttpResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/gateway/tests/msw/anthropicSse.ts
git commit -m "test(gateway): MSW SSE handler for Anthropic streaming"
```

### Task 12.2: StreamTranscript SSE integration test

**Files:**
- Create: `apps/gateway/tests/integration/streamTranscriptSse.integration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// apps/gateway/tests/integration/streamTranscriptSse.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { streamUsageExtractor } from '../../src/streaming/streamUsageExtractor';
import { createAnthropicSseHandler, happyTextScript, toolUseSplitScript } from '../msw/anthropicSse';
import { anthropicFetchStream } from '../../src/anthropic/stream';

describe('SSE → StreamTranscript integration', () => {
  let server: ReturnType<typeof setupServer>;

  beforeAll(() => {
    server = setupServer(createAnthropicSseHandler(happyTextScript()));
    server.listen();
  });

  afterAll(() => server.close());

  it('assembles plain text response', async () => {
    const stream = await anthropicFetchStream({ model: 'claude-haiku-4-5', messages: [] });
    const transcript = await streamUsageExtractor(stream);

    expect(transcript.content).toBe('Hello world');
    expect(transcript.usage.inputTokens).toBe(100);
    expect(transcript.usage.outputTokens).toBe(20);
    expect(transcript.toolUses).toEqual([]);
  });

  it('assembles tool_use with 5-chunk split input', async () => {
    server.use(createAnthropicSseHandler(toolUseSplitScript()));
    const stream = await anthropicFetchStream({ model: 'claude-haiku-4-5', messages: [] });
    const transcript = await streamUsageExtractor(stream);

    expect(transcript.toolUses).toHaveLength(1);
    expect(transcript.toolUses[0].name).toBe('read');
    expect(transcript.toolUses[0].input).toEqual({ path: 'a.txt' });
  });

  it('handles retry-mid-stream (stream interrupted, new request succeeds)', async () => {
    // First attempt: truncated (no message_stop)
    const truncated = {
      chunks: happyTextScript().chunks.slice(0, 3),
    };
    server.use(createAnthropicSseHandler(truncated));

    const stream1 = await anthropicFetchStream({ model: 'claude-haiku-4-5', messages: [] });
    const partial = await streamUsageExtractor(stream1).catch(e => e);
    expect(partial).toBeInstanceOf(Error);

    // Retry succeeds
    server.use(createAnthropicSseHandler(happyTextScript()));
    const stream2 = await anthropicFetchStream({ model: 'claude-haiku-4-5', messages: [] });
    const transcript = await streamUsageExtractor(stream2);
    expect(transcript.content).toBe('Hello world');
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter @aide/gateway test integration/streamTranscriptSse`
Expected: 3 tests pass

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/tests/integration/streamTranscriptSse.integration.test.ts
git commit -m "test(gateway): SSE → StreamTranscript integration (3 scenarios)"
```

### Task 12.3: Release workflow — drop arm64 from web image

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`

- [ ] **Step 1: Inspect current release.yml**

Run: `grep -n "platforms:" .github/workflows/release.yml`

- [ ] **Step 2: Modify web job's platforms**

In the `build-web` job (or whatever the web Docker step is called), change:

```yaml
platforms: linux/amd64,linux/arm64
```

to:

```yaml
platforms: linux/amd64
```

Leave api and gateway jobs unchanged (they keep `linux/amd64,linux/arm64`).

- [ ] **Step 3: Update README image matrix**

Locate the "Docker images" section of `README.md` and replace with:

```markdown
## Docker images

| Image | amd64 | arm64 |
|-------|-------|-------|
| `ghcr.io/hanfour/aide-api` | ✅ | ✅ |
| `ghcr.io/hanfour/aide-gateway` | ✅ | ✅ |
| `ghcr.io/hanfour/aide-web` | ✅ | ❌ (removed in v0.5.0; QEMU build was unstable) |

Deploy the web image on amd64 hosts. For arm64 (e.g. Graviton, Raspberry Pi),
self-build via `docker buildx build --platform linux/arm64 ./docker/Dockerfile.web`.
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml README.md
git commit -m "ci: drop arm64 from web Docker image (QEMU instability)"
```

**Phase 1 complete.** Proceed to canary observation per spec Stage 1 before merging Phase 2 PRs.

---

## Part 13 — Facet schema (migration 0005)

### Task 13.1: Migration 0005 up/down

**Files:**
- Create: `db/migrations/0005_facet_table.sql`
- Create: `db/migrations/0005_facet_table.down.sql`

- [ ] **Step 1: Write up migration**

```sql
-- db/migrations/0005_facet_table.sql
BEGIN;

CREATE TABLE request_body_facets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_body_id       UUID NOT NULL UNIQUE REFERENCES request_bodies(id) ON DELETE CASCADE,
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_type          VARCHAR(32) NULL
    CHECK (session_type IS NULL OR session_type IN
      ('feature_dev','bug_fix','refactor','exploration','other')),
  outcome               VARCHAR(16) NULL
    CHECK (outcome IS NULL OR outcome IN
      ('success','partial','failure','abandoned')),
  claude_helpfulness    SMALLINT NULL
    CHECK (claude_helpfulness IS NULL OR claude_helpfulness BETWEEN 1 AND 5),
  friction_count        INTEGER NULL CHECK (friction_count IS NULL OR friction_count >= 0),
  bugs_caught_count     INTEGER NULL CHECK (bugs_caught_count IS NULL OR bugs_caught_count >= 0),
  codex_errors_count    INTEGER NULL CHECK (codex_errors_count IS NULL OR codex_errors_count >= 0),
  extracted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  extracted_with_model  VARCHAR(64) NOT NULL,
  prompt_version        INTEGER NOT NULL,
  extraction_error      TEXT NULL
);

CREATE INDEX idx_facets_org_extracted   ON request_body_facets (org_id, extracted_at);
CREATE INDEX idx_facets_prompt_version  ON request_body_facets (prompt_version);

ALTER TABLE evaluation_reports
  ADD COLUMN llm_cost_usd NUMERIC(10,6) NULL;

COMMIT;
```

- [ ] **Step 2: Write down migration**

```sql
-- db/migrations/0005_facet_table.down.sql
BEGIN;
ALTER TABLE evaluation_reports DROP COLUMN IF EXISTS llm_cost_usd;
DROP INDEX IF EXISTS idx_facets_prompt_version;
DROP INDEX IF EXISTS idx_facets_org_extracted;
DROP TABLE IF EXISTS request_body_facets;
COMMIT;
```

- [ ] **Step 3: Verify up-down-up**

Run: `pnpm --filter @aide/api migrate:up && pnpm --filter @aide/api migrate:down && pnpm --filter @aide/api migrate:up`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0005_facet_table.sql db/migrations/0005_facet_table.down.sql
git commit -m "feat(db): migration 0005 request_body_facets + evaluation_reports.llm_cost_usd"
```

### Task 13.2: Migration 0005 integration test

**Files:**
- Create: `apps/api/tests/integration/migrations/0005.test.ts`

- [ ] **Step 1: Write test**

```typescript
// apps/api/tests/integration/migrations/0005.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestDb, applyMigrationsUpTo } from '../../helpers/db';

describe('migration 0005 facet table', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    db = await createTestDb();
    await applyMigrationsUpTo(db, '0005');
  });

  it('creates request_body_facets with expected columns', async () => {
    const cols = await db.many(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='request_body_facets' ORDER BY ordinal_position
    `);
    expect(cols.map(c => c.column_name)).toEqual([
      'id','request_body_id','org_id','session_type','outcome',
      'claude_helpfulness','friction_count','bugs_caught_count','codex_errors_count',
      'extracted_at','extracted_with_model','prompt_version','extraction_error',
    ]);
  });

  it('enforces session_type CHECK', async () => {
    const org = await db.one(`INSERT INTO organizations (name) VALUES ('t') RETURNING id`);
    const body = await db.one(`INSERT INTO request_bodies (org_id, encrypted_payload) VALUES ($1, 'x') RETURNING id`, [org.id]);
    await expect(db.none(`
      INSERT INTO request_body_facets
        (request_body_id, org_id, session_type, extracted_with_model, prompt_version)
      VALUES ($1, $2, 'invalid', 'claude-haiku-4-5', 1)
    `, [body.id, org.id])).rejects.toThrow(/check constraint/i);
  });

  it('enforces claude_helpfulness range', async () => {
    const org = await db.one(`INSERT INTO organizations (name) VALUES ('t2') RETURNING id`);
    const body = await db.one(`INSERT INTO request_bodies (org_id, encrypted_payload) VALUES ($1, 'x') RETURNING id`, [org.id]);
    await expect(db.none(`
      INSERT INTO request_body_facets
        (request_body_id, org_id, claude_helpfulness, extracted_with_model, prompt_version)
      VALUES ($1, $2, 6, 'claude-haiku-4-5', 1)
    `, [body.id, org.id])).rejects.toThrow(/check constraint/i);
  });

  it('unique constraint on request_body_id', async () => {
    const org = await db.one(`INSERT INTO organizations (name) VALUES ('t3') RETURNING id`);
    const body = await db.one(`INSERT INTO request_bodies (org_id, encrypted_payload) VALUES ($1, 'x') RETURNING id`, [org.id]);
    await db.none(`INSERT INTO request_body_facets (request_body_id, org_id, extracted_with_model, prompt_version) VALUES ($1, $2, 'm', 1)`, [body.id, org.id]);
    await expect(db.none(`INSERT INTO request_body_facets (request_body_id, org_id, extracted_with_model, prompt_version) VALUES ($1, $2, 'm', 1)`, [body.id, org.id])).rejects.toThrow(/unique/i);
  });

  it('adds llm_cost_usd column to evaluation_reports', async () => {
    const r = await db.one(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name='evaluation_reports' AND column_name='llm_cost_usd'
    `);
    expect(r.data_type).toBe('numeric');
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter @aide/api test integration/migrations/0005`
Expected: 5 tests pass

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/integration/migrations/0005.test.ts
git commit -m "test(db): migration 0005 integration test"
```

---

## Part 14 — Facet prompt + parser

### Task 14.1: Prompt builder

**Files:**
- Create: `packages/evaluator/src/facet/promptBuilder.ts`
- Test: `packages/evaluator/tests/facet/promptBuilder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/evaluator/tests/facet/promptBuilder.test.ts
import { describe, it, expect } from 'vitest';
import { buildFacetPrompt, CURRENT_PROMPT_VERSION, truncateTurns } from '../../src/facet/promptBuilder';

describe('buildFacetPrompt', () => {
  it('exports CURRENT_PROMPT_VERSION = 1 initially', () => {
    expect(CURRENT_PROMPT_VERSION).toBe(1);
  });

  it('produces system prompt containing the schema', () => {
    const p = buildFacetPrompt({ turns: [{ role: 'user', content: 'hi' }] });
    expect(p.system).toContain('sessionType');
    expect(p.system).toContain('feature_dev');
    expect(p.system).toContain('claudeHelpfulness');
    expect(p.system).toContain('Output JSON only');
  });

  it('serializes turns into user prompt', () => {
    const p = buildFacetPrompt({
      turns: [
        { role: 'user', content: 'fix the bug' },
        { role: 'assistant', content: 'here is the fix' },
      ],
    });
    expect(p.user).toContain('user: fix the bug');
    expect(p.user).toContain('assistant: here is the fix');
  });

  it('sets maxTokens: 256', () => {
    const p = buildFacetPrompt({ turns: [] });
    expect(p.maxTokens).toBe(256);
  });
});

describe('truncateTurns', () => {
  it('keeps all turns under budget', () => {
    const turns = Array.from({ length: 5 }, (_, i) => ({ role: 'user' as const, content: `short ${i}` }));
    const out = truncateTurns(turns, 10_000);
    expect(out.turns).toEqual(turns);
    expect(out.truncated).toBe(false);
  });

  it('keeps head and tail when over budget', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: 'x'.repeat(2000),
    }));
    const out = truncateTurns(turns, 8_000);
    expect(out.truncated).toBe(true);
    // head + placeholder + tail — at least the first and last turn preserved
    expect(out.turns[0].content).toBe(turns[0].content);
    expect(out.turns[out.turns.length - 1].content).toBe(turns[turns.length - 1].content);
    expect(out.turns.some(t => t.content.includes('truncated'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/evaluator test facet/promptBuilder`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

```typescript
// packages/evaluator/src/facet/promptBuilder.ts
export const CURRENT_PROMPT_VERSION = 1;

const SYSTEM_PROMPT = `You are an evaluator analysing a single Claude Code session. Given the transcript, classify it against the schema below. Output JSON only, no prose, no markdown.

Schema:
{
  "sessionType": "feature_dev" | "bug_fix" | "refactor" | "exploration" | "other",
  "outcome":     "success" | "partial" | "failure" | "abandoned",
  "claudeHelpfulness": 1 | 2 | 3 | 4 | 5,
  "frictionCount":     non-negative integer,
  "bugsCaughtCount":   non-negative integer,
  "codexErrorsCount":  non-negative integer
}

Definitions:
- frictionCount: user-visible pain points (misunderstanding, rework, confusion)
- bugsCaughtCount: defects Claude identified in user's code
- codexErrorsCount: tool/parse errors from Claude's own output

Examples:
Example 1 (feature_dev success):
{"sessionType":"feature_dev","outcome":"success","claudeHelpfulness":5,"frictionCount":0,"bugsCaughtCount":1,"codexErrorsCount":0}

Example 2 (bug_fix failure):
{"sessionType":"bug_fix","outcome":"failure","claudeHelpfulness":2,"frictionCount":3,"bugsCaughtCount":0,"codexErrorsCount":2}

Example 3 (exploration abandoned):
{"sessionType":"exploration","outcome":"abandoned","claudeHelpfulness":3,"frictionCount":1,"bugsCaughtCount":0,"codexErrorsCount":0}`;

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export interface FacetPrompt {
  system: string;
  user: string;
  maxTokens: number;
}

function approxTokens(s: string): number {
  // rough: 4 chars ≈ 1 token
  return Math.ceil(s.length / 4);
}

export function truncateTurns(turns: Turn[], maxTokens: number): { turns: Turn[]; truncated: boolean } {
  const total = turns.reduce((acc, t) => acc + approxTokens(t.content), 0);
  if (total <= maxTokens) return { turns, truncated: false };

  const headBudget = Math.floor(maxTokens * 0.4);
  const tailBudget = Math.floor(maxTokens * 0.4);

  const head: Turn[] = [];
  let used = 0;
  for (const t of turns) {
    const tk = approxTokens(t.content);
    if (used + tk > headBudget) break;
    head.push(t);
    used += tk;
  }

  const tail: Turn[] = [];
  let usedTail = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const tk = approxTokens(t.content);
    if (usedTail + tk > tailBudget) break;
    tail.unshift(t);
    usedTail += tk;
  }

  const skipped = turns.length - head.length - tail.length;
  const skippedTokens = total - used - usedTail;
  const placeholder: Turn = {
    role: 'user',
    content: `[... ${skipped} turns / ~${skippedTokens} tokens truncated ...]`,
  };

  return { turns: [...head, placeholder, ...tail], truncated: true };
}

export function buildFacetPrompt({ turns }: { turns: Turn[] }): FacetPrompt {
  const { turns: trimmed } = truncateTurns(turns, 8000);
  const user = trimmed.map(t => `${t.role}: ${t.content}`).join('\n\n');
  return {
    system: SYSTEM_PROMPT,
    user,
    maxTokens: 256,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/evaluator test facet/promptBuilder`
Expected: 6 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/facet/promptBuilder.ts packages/evaluator/tests/facet/promptBuilder.test.ts
git commit -m "feat(evaluator): facet prompt builder with head/tail truncation"
```

### Task 14.2: Facet parser

**Files:**
- Create: `packages/evaluator/src/facet/parser.ts`
- Test: `packages/evaluator/tests/facet/parser.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/evaluator/tests/facet/parser.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseFacet,
  FacetParseError,
  FacetValidationError,
  FacetFields,
} from '../../src/facet/parser';

describe('parseFacet', () => {
  const valid = {
    sessionType: 'feature_dev',
    outcome: 'success',
    claudeHelpfulness: 4,
    frictionCount: 0,
    bugsCaughtCount: 1,
    codexErrorsCount: 0,
  };

  it('parses plain JSON', () => {
    const out = parseFacet(JSON.stringify(valid));
    expect(out).toEqual(valid);
  });

  it('parses code-fenced JSON', () => {
    const out = parseFacet('```json\n' + JSON.stringify(valid) + '\n```');
    expect(out).toEqual(valid);
  });

  it('throws FacetParseError on invalid JSON', () => {
    expect(() => parseFacet('not json')).toThrow(FacetParseError);
  });

  it('throws FacetValidationError on out-of-range helpfulness', () => {
    expect(() => parseFacet(JSON.stringify({ ...valid, claudeHelpfulness: 0 }))).toThrow(FacetValidationError);
    expect(() => parseFacet(JSON.stringify({ ...valid, claudeHelpfulness: 6 }))).toThrow(FacetValidationError);
  });

  it('throws FacetValidationError on invalid enum', () => {
    expect(() => parseFacet(JSON.stringify({ ...valid, sessionType: 'coding' }))).toThrow(FacetValidationError);
  });

  it('throws FacetValidationError on missing required field', () => {
    const { outcome: _, ...partial } = valid;
    expect(() => parseFacet(JSON.stringify(partial))).toThrow(FacetValidationError);
  });

  it('throws FacetValidationError on negative counts', () => {
    expect(() => parseFacet(JSON.stringify({ ...valid, frictionCount: -1 }))).toThrow(FacetValidationError);
  });

  it('ignores extra fields', () => {
    const out = parseFacet(JSON.stringify({ ...valid, extra: 'ignored' }));
    expect(out).toEqual(valid);
    expect((out as any).extra).toBeUndefined();
  });

  it('parses JSON with leading whitespace / stray prose removed', () => {
    const out = parseFacet('Here is the result:\n' + JSON.stringify(valid));
    expect(out).toEqual(valid);
  });

  it('uses distinguishable error classes', () => {
    try { parseFacet('not json'); } catch (e) {
      expect(e).toBeInstanceOf(FacetParseError);
      expect(e).not.toBeInstanceOf(FacetValidationError);
    }
    try { parseFacet(JSON.stringify({ ...valid, claudeHelpfulness: 'high' })); } catch (e) {
      expect(e).toBeInstanceOf(FacetValidationError);
      expect(e).not.toBeInstanceOf(FacetParseError);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/evaluator test facet/parser`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

```typescript
// packages/evaluator/src/facet/parser.ts
import { z } from 'zod';

export class FacetParseError extends Error {
  constructor(msg: string) { super(msg); this.name = 'FacetParseError'; }
}
export class FacetValidationError extends Error {
  constructor(msg: string) { super(msg); this.name = 'FacetValidationError'; }
}

const FacetSchema = z.object({
  sessionType: z.enum(['feature_dev','bug_fix','refactor','exploration','other']),
  outcome: z.enum(['success','partial','failure','abandoned']),
  claudeHelpfulness: z.number().int().min(1).max(5),
  frictionCount: z.number().int().nonnegative(),
  bugsCaughtCount: z.number().int().nonnegative(),
  codexErrorsCount: z.number().int().nonnegative(),
}).strict(); // extra fields rejected

export type FacetFields = z.infer<typeof FacetSchema>;

function extractJson(raw: string): string {
  // strip code fences
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1];

  // find first { … } balanced substring
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return raw;
  return raw.slice(first, last + 1);
}

export function parseFacet(raw: string): FacetFields {
  const jsonText = extractJson(raw.trim());
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch (e: any) {
    throw new FacetParseError(`Invalid JSON: ${e.message}`);
  }

  // Strip extra fields manually (z.strict() would throw, but we want to ignore)
  if (data && typeof data === 'object') {
    const allowedKeys = ['sessionType','outcome','claudeHelpfulness','frictionCount','bugsCaughtCount','codexErrorsCount'];
    const cleaned: Record<string, unknown> = {};
    for (const k of allowedKeys) {
      if (k in (data as object)) cleaned[k] = (data as any)[k];
    }
    data = cleaned;
  }

  const result = FacetSchema.safeParse(data);
  if (!result.success) {
    throw new FacetValidationError(`Facet validation failed: ${result.error.message}`);
  }
  return result.data;
}
```

Note the test for "ignores extra fields" — so we use a manual clean step instead of `z.strict()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/evaluator test facet/parser`
Expected: 10 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/facet/parser.ts packages/evaluator/tests/facet/parser.test.ts
git commit -m "feat(evaluator): facet parser with Zod validation + code-fence stripping"
```

---

## Part 15 — Facet extractor + ensureFacets + evaluator integration

### Task 15.1: extractOne (single-session facet)

**Files:**
- Create: `packages/evaluator/src/facet/extractor.ts`
- Test: `packages/evaluator/tests/facet/extractor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/evaluator/tests/facet/extractor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractOne } from '../../src/facet/extractor';
import { FacetParseError, FacetValidationError } from '../../src/facet/parser';
import { BudgetExceededDegrade, BudgetExceededHalt } from '../../src/budget/errors';
import { CURRENT_PROMPT_VERSION } from '../../src/facet/promptBuilder';

const session = {
  request_body_id: 'body-1',
  org_id: 'org-1',
  turns: [{ role: 'user' as const, content: 'hi' }],
};

describe('extractOne', () => {
  let mockCallWithCostTracking: ReturnType<typeof vi.fn>;
  let mockInsertFacet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCallWithCostTracking = vi.fn();
    mockInsertFacet = vi.fn().mockResolvedValue(undefined);
  });

  const deps = () => ({
    callWithCostTracking: mockCallWithCostTracking,
    insertFacet: mockInsertFacet,
    facetModel: 'claude-haiku-4-5',
  });

  it('writes facet row on successful extraction', async () => {
    mockCallWithCostTracking.mockResolvedValue({
      response: { text: '{"sessionType":"feature_dev","outcome":"success","claudeHelpfulness":5,"frictionCount":0,"bugsCaughtCount":1,"codexErrorsCount":0}', usage: { input_tokens: 100, output_tokens: 30 } },
      cost: 0.001,
    });

    const facet = await extractOne(session, deps());
    expect(facet?.sessionType).toBe('feature_dev');
    expect(mockInsertFacet).toHaveBeenCalledWith(expect.objectContaining({
      request_body_id: 'body-1',
      org_id: 'org-1',
      session_type: 'feature_dev',
      outcome: 'success',
      claude_helpfulness: 5,
      bugs_caught_count: 1,
      prompt_version: CURRENT_PROMPT_VERSION,
      extracted_with_model: 'claude-haiku-4-5',
      extraction_error: null,
    }));
  });

  it('writes error row on parse_error (deterministic, no retry)', async () => {
    mockCallWithCostTracking.mockResolvedValue({
      response: { text: 'not json', usage: { input_tokens: 100, output_tokens: 5 } },
      cost: 0.0005,
    });
    const facet = await extractOne(session, deps());
    expect(facet).toBeNull();
    expect(mockInsertFacet).toHaveBeenCalledWith(expect.objectContaining({
      session_type: null,
      extraction_error: expect.stringMatching(/^parse_error/),
    }));
  });

  it('writes error row on validation_error', async () => {
    mockCallWithCostTracking.mockResolvedValue({
      response: { text: '{"sessionType":"invalid","outcome":"success","claudeHelpfulness":5,"frictionCount":0,"bugsCaughtCount":0,"codexErrorsCount":0}', usage: { input_tokens: 100, output_tokens: 20 } },
      cost: 0.0005,
    });
    await extractOne(session, deps());
    expect(mockInsertFacet).toHaveBeenCalledWith(expect.objectContaining({
      extraction_error: expect.stringMatching(/^validation_error/),
    }));
  });

  it('writes error row on timeout', async () => {
    mockCallWithCostTracking.mockRejectedValue(new Error('timeout'));
    await extractOne(session, deps());
    expect(mockInsertFacet).toHaveBeenCalledWith(expect.objectContaining({
      extraction_error: expect.stringMatching(/^timeout/),
    }));
  });

  it('skips row write on BudgetExceededDegrade (retry next eval)', async () => {
    mockCallWithCostTracking.mockRejectedValue(new BudgetExceededDegrade({
      orgId: 'org-1', estimatedCost: 0.1, currentSpend: 10, budget: 10,
    }));
    const result = await extractOne(session, deps());
    expect(result).toBeNull();
    expect(mockInsertFacet).not.toHaveBeenCalled();
  });

  it('skips row write on BudgetExceededHalt', async () => {
    mockCallWithCostTracking.mockRejectedValue(new BudgetExceededHalt({
      orgId: 'org-1', estimatedCost: 0.1, currentSpend: 10, budget: 10,
    }));
    const result = await extractOne(session, deps());
    expect(result).toBeNull();
    expect(mockInsertFacet).not.toHaveBeenCalled();
  });

  it('skips row write on api_error (5xx is transient)', async () => {
    const e = new Error('Anthropic 503'); (e as any).status = 503;
    mockCallWithCostTracking.mockRejectedValue(e);
    const result = await extractOne(session, deps());
    expect(result).toBeNull();
    expect(mockInsertFacet).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/evaluator test facet/extractor`
Expected: FAIL (module not found)

- [ ] **Step 3: Write implementation**

```typescript
// packages/evaluator/src/facet/extractor.ts
import { buildFacetPrompt, CURRENT_PROMPT_VERSION, Turn } from './promptBuilder';
import { parseFacet, FacetParseError, FacetValidationError, FacetFields } from './parser';
import { isBudgetError } from '../budget/errors';

export interface Session {
  request_body_id: string;
  org_id: string;
  turns: Turn[];
}

export interface FacetRow {
  request_body_id: string;
  org_id: string;
  session_type: string | null;
  outcome: string | null;
  claude_helpfulness: number | null;
  friction_count: number | null;
  bugs_caught_count: number | null;
  codex_errors_count: number | null;
  extracted_with_model: string;
  prompt_version: number;
  extraction_error: string | null;
}

export interface ExtractorDeps {
  callWithCostTracking: (args: {
    orgId: string;
    eventType: 'facet_extraction';
    model: string;
    refType: 'request_body_facet';
    refId?: string;
    prompt: { system: string; user: string; maxTokens: number };
    estimatedInputTokens: number;
  }) => Promise<{ response: { text: string; usage: { input_tokens: number; output_tokens: number } }; cost: number }>;
  insertFacet: (row: FacetRow) => Promise<void>;
  facetModel: string;
}

function classifyError(e: unknown): string {
  if (e instanceof FacetParseError) return `parse_error: ${e.message}`;
  if (e instanceof FacetValidationError) return `validation_error: ${e.message}`;
  if (e instanceof Error && /timeout/i.test(e.message)) return `timeout: ${e.message}`;
  return '';
}

function isTransientApiError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const status = (e as any).status;
  return typeof status === 'number' && status >= 500 && status < 600;
}

export async function extractOne(session: Session, deps: ExtractorDeps): Promise<FacetFields | null> {
  const prompt = buildFacetPrompt({ turns: session.turns });
  const estTokens = Math.ceil(prompt.user.length / 4) + Math.ceil(prompt.system.length / 4);

  let response: { text: string; usage: { input_tokens: number; output_tokens: number } };
  try {
    const result = await deps.callWithCostTracking({
      orgId: session.org_id,
      eventType: 'facet_extraction',
      model: deps.facetModel,
      refType: 'request_body_facet',
      prompt,
      estimatedInputTokens: estTokens,
    });
    response = result.response;
  } catch (e) {
    if (isBudgetError(e)) return null;
    if (isTransientApiError(e)) return null;
    // timeout and other local errors: write row with error
    await deps.insertFacet({
      request_body_id: session.request_body_id,
      org_id: session.org_id,
      session_type: null,
      outcome: null,
      claude_helpfulness: null,
      friction_count: null,
      bugs_caught_count: null,
      codex_errors_count: null,
      extracted_with_model: deps.facetModel,
      prompt_version: CURRENT_PROMPT_VERSION,
      extraction_error: classifyError(e) || `unknown_error: ${(e as Error).message}`,
    });
    return null;
  }

  try {
    const facet = parseFacet(response.text);
    await deps.insertFacet({
      request_body_id: session.request_body_id,
      org_id: session.org_id,
      session_type: facet.sessionType,
      outcome: facet.outcome,
      claude_helpfulness: facet.claudeHelpfulness,
      friction_count: facet.frictionCount,
      bugs_caught_count: facet.bugsCaughtCount,
      codex_errors_count: facet.codexErrorsCount,
      extracted_with_model: deps.facetModel,
      prompt_version: CURRENT_PROMPT_VERSION,
      extraction_error: null,
    });
    return facet;
  } catch (e) {
    await deps.insertFacet({
      request_body_id: session.request_body_id,
      org_id: session.org_id,
      session_type: null,
      outcome: null,
      claude_helpfulness: null,
      friction_count: null,
      bugs_caught_count: null,
      codex_errors_count: null,
      extracted_with_model: deps.facetModel,
      prompt_version: CURRENT_PROMPT_VERSION,
      extraction_error: classifyError(e) || `unknown_error: ${(e as Error).message}`,
    });
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/evaluator test facet/extractor`
Expected: 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/facet/extractor.ts packages/evaluator/tests/facet/extractor.test.ts
git commit -m "feat(evaluator): extractOne facet extractor with error classification"
```

### Task 15.2: ensureFacets batch

**Files:**
- Create: `packages/evaluator/src/facet/ensureFacets.ts`
- Test: `packages/evaluator/tests/facet/ensureFacets.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/evaluator/tests/facet/ensureFacets.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureFacets } from '../../src/facet/ensureFacets';
import { CURRENT_PROMPT_VERSION } from '../../src/facet/promptBuilder';

const sessions = [
  { request_body_id: 'a', org_id: 'o', turns: [] },
  { request_body_id: 'b', org_id: 'o', turns: [] },
  { request_body_id: 'c', org_id: 'o', turns: [] },
];

describe('ensureFacets', () => {
  let mockGetFacet: ReturnType<typeof vi.fn>;
  let mockExtractOne: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetFacet = vi.fn();
    mockExtractOne = vi.fn().mockResolvedValue({});
  });

  const deps = () => ({ getFacet: mockGetFacet, extractOne: mockExtractOne, concurrency: 2 });

  it('skips sessions with current-prompt-version facet already present', async () => {
    mockGetFacet.mockImplementation((bodyId) =>
      bodyId === 'a' ? Promise.resolve({ prompt_version: CURRENT_PROMPT_VERSION }) : Promise.resolve(null)
    );
    await ensureFacets(sessions, deps());
    expect(mockExtractOne).toHaveBeenCalledTimes(2);
    expect(mockExtractOne).not.toHaveBeenCalledWith(expect.objectContaining({ request_body_id: 'a' }), expect.anything());
  });

  it('re-extracts sessions with stale prompt_version', async () => {
    mockGetFacet.mockResolvedValue({ prompt_version: 0 });
    await ensureFacets(sessions, deps());
    expect(mockExtractOne).toHaveBeenCalledTimes(3);
  });

  it('runs with bounded concurrency', async () => {
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    mockExtractOne.mockImplementation(async (s: any) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(`start-${s.request_body_id}`);
      await new Promise(r => setTimeout(r, 20));
      order.push(`end-${s.request_body_id}`);
      concurrent--;
    });
    mockGetFacet.mockResolvedValue(null);
    await ensureFacets(sessions, deps());
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/evaluator test facet/ensureFacets`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// packages/evaluator/src/facet/ensureFacets.ts
import { Session } from './extractor';
import { CURRENT_PROMPT_VERSION } from './promptBuilder';

export interface EnsureFacetsDeps {
  getFacet: (requestBodyId: string) => Promise<{ prompt_version: number } | null>;
  extractOne: (session: Session) => Promise<unknown>;
  concurrency: number;
}

async function parallelMap<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]);
    }
  });
  await Promise.all(workers);
}

export async function ensureFacets(sessions: Session[], deps: EnsureFacetsDeps): Promise<void> {
  const needExtract: Session[] = [];
  for (const s of sessions) {
    const existing = await deps.getFacet(s.request_body_id);
    if (existing && existing.prompt_version === CURRENT_PROMPT_VERSION) continue;
    needExtract.push(s);
  }
  await parallelMap(needExtract, deps.concurrency, (s) => deps.extractOne(s).then(() => undefined));
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @aide/evaluator test facet/ensureFacets`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/facet/ensureFacets.ts packages/evaluator/tests/facet/ensureFacets.test.ts
git commit -m "feat(evaluator): ensureFacets batch with concurrency cap"
```

### Task 15.3: Gateway worker integration

**Files:**
- Modify: `apps/gateway/src/workers/evaluator/runEvaluation.ts`
- Create: `apps/gateway/src/workers/evaluator/facetDeps.ts`
- Test: `apps/gateway/tests/workers/evaluator/runEvaluation.facet.integration.test.ts`

- [ ] **Step 1: Write facetDeps wiring**

```typescript
// apps/gateway/src/workers/evaluator/facetDeps.ts
import type { Pool } from 'pg';
import { callWithCostTracking } from '@aide/evaluator/llm/callWithCostTracking';
import { extractOne, FacetRow } from '@aide/evaluator/facet/extractor';
import { anthropicClient } from '../../anthropic/client';
import { wrapEnforceBudget } from './enforceBudgetWithMetrics';
import { createBudgetDeps } from './budgetDeps';
import { createLedgerWriter } from './ledgerWriter';
import { gwFacetExtractTotal, gwFacetExtractDurationMs } from '../../metrics';

export function createFacetDeps(db: Pool, facetModel: string) {
  const enforce = wrapEnforceBudget(createBudgetDeps(db));
  const insertLedger = createLedgerWriter(db);

  const wrappedCall: Parameters<typeof extractOne>[1]['callWithCostTracking'] = async (args) => {
    const start = Date.now();
    try {
      const result = await callWithCostTracking(args, {
        llmClient: anthropicClient,
        enforceBudget: enforce,
        insertLedger,
      });
      gwFacetExtractTotal.inc({ org_id: args.orgId, result: 'success' });
      gwFacetExtractDurationMs.observe({ org_id: args.orgId }, Date.now() - start);
      return result;
    } catch (e) {
      gwFacetExtractDurationMs.observe({ org_id: args.orgId }, Date.now() - start);
      const label = e instanceof Error && /timeout/i.test(e.message) ? 'timeout'
        : (e as any)?.status >= 500 ? 'api_error'
        : 'budget_skip';
      gwFacetExtractTotal.inc({ org_id: args.orgId, result: label });
      throw e;
    }
  };

  const insertFacet = async (row: FacetRow) => {
    await db.query(
      `INSERT INTO request_body_facets
         (request_body_id, org_id, session_type, outcome, claude_helpfulness,
          friction_count, bugs_caught_count, codex_errors_count,
          extracted_with_model, prompt_version, extraction_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (request_body_id) DO UPDATE SET
         session_type=EXCLUDED.session_type,
         outcome=EXCLUDED.outcome,
         claude_helpfulness=EXCLUDED.claude_helpfulness,
         friction_count=EXCLUDED.friction_count,
         bugs_caught_count=EXCLUDED.bugs_caught_count,
         codex_errors_count=EXCLUDED.codex_errors_count,
         extracted_with_model=EXCLUDED.extracted_with_model,
         prompt_version=EXCLUDED.prompt_version,
         extraction_error=EXCLUDED.extraction_error,
         extracted_at=now()`,
      [
        row.request_body_id, row.org_id, row.session_type, row.outcome, row.claude_helpfulness,
        row.friction_count, row.bugs_caught_count, row.codex_errors_count,
        row.extracted_with_model, row.prompt_version, row.extraction_error,
      ],
    );
    if (row.extraction_error) {
      const kind = row.extraction_error.split(':')[0];
      gwFacetExtractTotal.inc({ org_id: row.org_id, result: kind });
    }
  };

  return { callWithCostTracking: wrappedCall, insertFacet, facetModel };
}
```

- [ ] **Step 2: Integrate into runEvaluation**

Modify `apps/gateway/src/workers/evaluator/runEvaluation.ts`. Locate the existing `loadSignals` call; insert `ensureFacets` before it:

```typescript
import { ensureFacets } from '@aide/evaluator/facet/ensureFacets';
import { extractOne } from '@aide/evaluator/facet/extractor';
import { createFacetDeps } from './facetDeps';
import { gwFacetCacheHitTotal } from '../../metrics';

// …inside runEvaluation function, after loadWindow → sessions:

if (
  process.env.ENABLE_FACET_EXTRACTION === 'true' &&
  org.llm_facet_enabled &&
  org.llm_facet_model
) {
  const facetDeps = createFacetDeps(ctx.db, org.llm_facet_model);

  await ensureFacets(sessions, {
    getFacet: async (bodyId) => {
      const r = await ctx.db.query(
        `SELECT prompt_version FROM request_body_facets WHERE request_body_id = $1`, [bodyId],
      );
      if (r.rows[0]) gwFacetCacheHitTotal.inc({ org_id: org.id });
      return r.rows[0] ?? null;
    },
    extractOne: (session) => extractOne(session, facetDeps),
    concurrency: 5,
  });
}
```

- [ ] **Step 3: Bump BullMQ timeout**

Locate BullMQ worker registration (e.g. `apps/gateway/src/workers/evaluator/index.ts`):

```typescript
new Worker('evaluator', processor, {
  connection: redis,
  lockDuration: 300_000,  // was 60_000
  stalledInterval: 60_000,
});
```

Add queue defaults in the queue creation call:
```typescript
{
  defaultJobOptions: {
    timeout: 300_000, // was 60_000
    attempts: 3,
  },
}
```

- [ ] **Step 4: Write integration test**

```typescript
// apps/gateway/tests/workers/evaluator/runEvaluation.facet.integration.test.ts
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { runEvaluation } from '../../../src/workers/evaluator/runEvaluation';
import { getTestDb, seedOrg, seedMember, seedRequestBody } from '../../helpers/db';
import { createAnthropicHandler } from '../../msw/anthropic';

describe('runEvaluation with facet extraction (integration)', () => {
  const db = getTestDb();
  let orgId: string, memberId: string;
  const server = setupServer(createAnthropicHandler({
    facetResponse: { sessionType: 'feature_dev', outcome: 'success', claudeHelpfulness: 5, frictionCount: 0, bugsCaughtCount: 1, codexErrorsCount: 0 },
  }));

  beforeAll(() => { process.env.ENABLE_FACET_EXTRACTION = 'true'; server.listen(); });
  afterAll(() => server.close());

  beforeEach(async () => {
    await db.query('TRUNCATE organizations, request_bodies, request_body_facets, evaluation_reports, llm_usage_events CASCADE');
    orgId = await seedOrg(db, {
      llm_eval_enabled: true, llm_eval_model: 'claude-haiku-4-5',
      llm_facet_enabled: true, llm_facet_model: 'claude-haiku-4-5',
      llm_monthly_budget_usd: 100,
    });
    memberId = await seedMember(db, { orgId });
    await seedRequestBody(db, { orgId, memberId });
  });

  it('writes facet rows and aggregates into report', async () => {
    await runEvaluation({ orgId, memberId, windowDays: 7 });
    const facets = await db.query('SELECT * FROM request_body_facets');
    expect(facets.rows.length).toBeGreaterThan(0);
    expect(facets.rows[0].session_type).toBe('feature_dev');

    const ledger = await db.query('SELECT * FROM llm_usage_events');
    expect(ledger.rows.some(r => r.event_type === 'facet_extraction')).toBe(true);

    const report = await db.query('SELECT * FROM evaluation_reports ORDER BY created_at DESC LIMIT 1');
    expect(report.rows[0].llm_cost_usd).not.toBeNull();
  });
});
```

- [ ] **Step 5: Run test**

Run: `pnpm --filter @aide/gateway test workers/evaluator/runEvaluation.facet`
Expected: 1 test passes

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/workers/evaluator/ apps/gateway/tests/workers/evaluator/runEvaluation.facet.integration.test.ts
git commit -m "feat(gateway): integrate ensureFacets into evaluator worker + bump timeout"
```

### Task 15.4: Degraded integration test

**Files:**
- Create: `apps/gateway/tests/workers/evaluator/runEvaluation.degraded.integration.test.ts`

- [ ] **Step 1: Write test**

```typescript
// apps/gateway/tests/workers/evaluator/runEvaluation.degraded.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { runEvaluation } from '../../../src/workers/evaluator/runEvaluation';
import { getTestDb, seedOrg, seedMember, seedRequestBody } from '../../helpers/db';

describe('runEvaluation degraded mode', () => {
  const db = getTestDb();
  let orgId: string, memberId: string;

  beforeEach(async () => {
    await db.query('TRUNCATE organizations, request_bodies, request_body_facets, evaluation_reports, llm_usage_events CASCADE');
    orgId = await seedOrg(db, {
      llm_eval_enabled: true, llm_eval_model: 'claude-haiku-4-5',
      llm_facet_enabled: true, llm_facet_model: 'claude-haiku-4-5',
      llm_monthly_budget_usd: 1.00,
      llm_budget_overage_behavior: 'degrade',
    });
    memberId = await seedMember(db, { orgId });
    await seedRequestBody(db, { orgId, memberId });

    // Pre-load ledger with near-budget spend
    await db.query(`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd)
      VALUES ($1, 'deep_analysis', 'claude-haiku-4-5', 1, 1, 0.99)
    `, [orgId]);
  });

  it('produces rule-based-only report when budget exhausted', async () => {
    await runEvaluation({ orgId, memberId, windowDays: 7 });

    const report = await db.query('SELECT * FROM evaluation_reports ORDER BY created_at DESC LIMIT 1');
    expect(report.rows[0]).toBeDefined();
    // Report still exists (rule-based fallback)
    expect(report.rows[0].score).not.toBeNull();
    // Facets written as null (budget skip)
    const facets = await db.query('SELECT * FROM request_body_facets');
    // Either no facets (budget blocked entirely) OR error rows — both acceptable degraded states
    expect(facets.rows.every(r => r.extraction_error !== null || r.session_type === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter @aide/gateway test workers/evaluator/runEvaluation.degraded`
Expected: 1 test passes

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/tests/workers/evaluator/runEvaluation.degraded.integration.test.ts
git commit -m "test(gateway): runEvaluation degraded mode (budget exhausted fallback)"
```

---

## Part 16 — Facet signals + null-aware rubric engine + rubric v2

### Task 16.1: Facet signal aggregators

**Files:**
- Create: `packages/evaluator/src/signals/facet.ts`
- Test: `packages/evaluator/tests/signals/facet.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/evaluator/tests/signals/facet.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateFacetSignals, FacetSignals } from '../../src/signals/facet';

interface FR {
  session_type: string | null;
  outcome: string | null;
  claude_helpfulness: number | null;
  friction_count: number | null;
  bugs_caught_count: number | null;
  codex_errors_count: number | null;
}

const mk = (p: Partial<FR>): FR => ({
  session_type: null, outcome: null, claude_helpfulness: null,
  friction_count: null, bugs_caught_count: null, codex_errors_count: null, ...p,
});

describe('aggregateFacetSignals', () => {
  it('returns null for all signals when array is empty', () => {
    const s = aggregateFacetSignals([]);
    expect(s).toEqual({
      facet_session_type_ratio: null,
      facet_outcome_success_rate: null,
      facet_claude_helpfulness: null,
      facet_friction_per_session: null,
      facet_bugs_caught: null,
      facet_codex_errors: null,
    });
  });

  it('returns null for a signal when all rows have null for that field', () => {
    const s = aggregateFacetSignals([mk({ outcome: 'success' }), mk({ outcome: 'failure' })]);
    expect(s.facet_claude_helpfulness).toBeNull();
    expect(s.facet_bugs_caught).toBeNull();
  });

  it('computes session_type ratio', () => {
    const s = aggregateFacetSignals([
      mk({ session_type: 'feature_dev' }),
      mk({ session_type: 'feature_dev' }),
      mk({ session_type: 'bug_fix' }),
      mk({ session_type: 'refactor' }),
    ]);
    expect(s.facet_session_type_ratio).toEqual({
      feature_dev: 0.5, bug_fix: 0.25, refactor: 0.25,
    });
  });

  it('computes outcome success rate (success + partial)', () => {
    const s = aggregateFacetSignals([
      mk({ outcome: 'success' }), mk({ outcome: 'partial' }),
      mk({ outcome: 'failure' }), mk({ outcome: 'abandoned' }),
    ]);
    expect(s.facet_outcome_success_rate).toBe(0.5);
  });

  it('computes claude_helpfulness mean', () => {
    const s = aggregateFacetSignals([
      mk({ claude_helpfulness: 5 }), mk({ claude_helpfulness: 3 }), mk({ claude_helpfulness: 4 }),
    ]);
    expect(s.facet_claude_helpfulness).toBeCloseTo(4, 6);
  });

  it('computes friction_per_session mean', () => {
    const s = aggregateFacetSignals([
      mk({ friction_count: 0 }), mk({ friction_count: 2 }), mk({ friction_count: 4 }),
    ]);
    expect(s.facet_friction_per_session).toBeCloseTo(2, 6);
  });

  it('computes bugs_caught sum', () => {
    const s = aggregateFacetSignals([
      mk({ bugs_caught_count: 1 }), mk({ bugs_caught_count: 3 }),
    ]);
    expect(s.facet_bugs_caught).toBe(4);
  });

  it('ignores null rows in mean/sum calculations', () => {
    const s = aggregateFacetSignals([
      mk({ bugs_caught_count: 2 }), mk({ bugs_caught_count: null }), mk({ bugs_caught_count: 3 }),
    ]);
    expect(s.facet_bugs_caught).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/evaluator test signals/facet`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// packages/evaluator/src/signals/facet.ts
export interface FacetRow {
  session_type: string | null;
  outcome: string | null;
  claude_helpfulness: number | null;
  friction_count: number | null;
  bugs_caught_count: number | null;
  codex_errors_count: number | null;
}

export interface FacetSignals {
  facet_session_type_ratio: Record<string, number> | null;
  facet_outcome_success_rate: number | null;
  facet_claude_helpfulness: number | null;
  facet_friction_per_session: number | null;
  facet_bugs_caught: number | null;
  facet_codex_errors: number | null;
}

function meanOf(nums: Array<number | null>): number | null {
  const present = nums.filter((n): n is number => n != null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

function sumOf(nums: Array<number | null>): number | null {
  const present = nums.filter((n): n is number => n != null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0);
}

export function aggregateFacetSignals(rows: FacetRow[]): FacetSignals {
  if (rows.length === 0) {
    return {
      facet_session_type_ratio: null,
      facet_outcome_success_rate: null,
      facet_claude_helpfulness: null,
      facet_friction_per_session: null,
      facet_bugs_caught: null,
      facet_codex_errors: null,
    };
  }

  const sessionTypes = rows.map(r => r.session_type).filter((v): v is string => v != null);
  let sessionTypeRatio: Record<string, number> | null = null;
  if (sessionTypes.length > 0) {
    sessionTypeRatio = {};
    for (const t of sessionTypes) {
      sessionTypeRatio[t] = (sessionTypeRatio[t] ?? 0) + 1;
    }
    for (const k of Object.keys(sessionTypeRatio)) {
      sessionTypeRatio[k] = sessionTypeRatio[k] / sessionTypes.length;
    }
  }

  const outcomes = rows.map(r => r.outcome).filter((v): v is string => v != null);
  const outcomeSuccessRate = outcomes.length === 0
    ? null
    : outcomes.filter(o => o === 'success' || o === 'partial').length / outcomes.length;

  return {
    facet_session_type_ratio: sessionTypeRatio,
    facet_outcome_success_rate: outcomeSuccessRate,
    facet_claude_helpfulness: meanOf(rows.map(r => r.claude_helpfulness)),
    facet_friction_per_session: meanOf(rows.map(r => r.friction_count)),
    facet_bugs_caught: sumOf(rows.map(r => r.bugs_caught_count)),
    facet_codex_errors: sumOf(rows.map(r => r.codex_errors_count)),
  };
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @aide/evaluator test signals/facet`
Expected: 8 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/evaluator/src/signals/facet.ts packages/evaluator/tests/signals/facet.test.ts
git commit -m "feat(evaluator): facet signal aggregators (6 new signal types)"
```

### Task 16.2: Null-aware rubric scoring

**Files:**
- Modify: `packages/evaluator/src/rubric/evaluator.ts`
- Test: `packages/evaluator/tests/rubric/nullAwareWeight.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/evaluator/tests/rubric/nullAwareWeight.test.ts
import { describe, it, expect } from 'vitest';
import { scoreSection, scoreReport } from '../../src/rubric/evaluator';

const section = {
  name: 'Test',
  declaredWeight: 40,
  criteria: [
    { name: 'A', weight: 30, signalType: 's_a', scoreFn: (v: any) => v * 10 },
    { name: 'B', weight: 40, signalType: 's_b', scoreFn: (v: any) => v * 10 },
    { name: 'C', weight: 30, signalType: 's_c', scoreFn: (v: any) => v * 10 },
  ],
};

describe('scoreSection null-aware weight redistribution', () => {
  it('normal case: all signals present', () => {
    const r = scoreSection(section, { s_a: 8, s_b: 6, s_c: 9 });
    expect(r.score).toBeCloseTo((80 * 30 + 60 * 40 + 90 * 30) / 100, 6);
    expect(r.excludedCriteria).toEqual([]);
  });

  it('one null signal: weights redistribute over remaining', () => {
    const r = scoreSection(section, { s_a: 8, s_b: null, s_c: 9 });
    // Active: A(30) + C(30) = 60 total
    // Score = (80 * 30 + 90 * 30) / 60 = 85
    expect(r.score).toBe(85);
    expect(r.excludedCriteria).toEqual([
      { name: 'B', reason: 'signal_null', originalWeight: 40 },
    ]);
  });

  it('two null signals', () => {
    const r = scoreSection(section, { s_a: null, s_b: 6, s_c: null });
    expect(r.score).toBe(60);
    expect(r.excludedCriteria).toHaveLength(2);
  });

  it('all null: section score is null', () => {
    const r = scoreSection(section, { s_a: null, s_b: null, s_c: null });
    expect(r.score).toBeNull();
    expect(r.excludedCriteria).toHaveLength(3);
  });
});

describe('scoreReport with null sections', () => {
  const sec1 = { name: 'S1', declaredWeight: 40, criteria: [{ name: 'X', weight: 100, signalType: 'x', scoreFn: (v: any) => v }] };
  const sec2 = { name: 'S2', declaredWeight: 60, criteria: [{ name: 'Y', weight: 100, signalType: 'y', scoreFn: (v: any) => v }] };

  it('aggregates across sections', () => {
    const r = scoreReport([sec1, sec2], { x: 70, y: 80 });
    expect(r.score).toBeCloseTo((70 * 40 + 80 * 60) / 100, 6);
  });

  it('excludes null section from report score', () => {
    const r = scoreReport([sec1, sec2], { x: null, y: 80 });
    expect(r.score).toBe(80);
  });

  it('flags llm_degraded when any section was null due to LLM-dependent signals', () => {
    const r = scoreReport([sec1, sec2], { x: null, y: 80 });
    expect(r.sections[0].score).toBeNull();
  });

  it('report score null when all sections null', () => {
    const r = scoreReport([sec1, sec2], { x: null, y: null });
    expect(r.score).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/evaluator test rubric/nullAwareWeight`
Expected: FAIL (functions missing or old signature)

- [ ] **Step 3: Write/modify implementation**

Replace or extend `packages/evaluator/src/rubric/evaluator.ts`:

```typescript
// packages/evaluator/src/rubric/evaluator.ts
export interface Criterion {
  name: string;
  weight: number;
  signalType: string;
  scoreFn: (signalValue: unknown) => number;
}

export interface Section {
  name: string;
  declaredWeight: number;
  criteria: Criterion[];
}

export interface ExcludedCriterion {
  name: string;
  reason: 'signal_null';
  originalWeight: number;
}

export interface SectionResult {
  name: string;
  declaredWeight: number;
  score: number | null;
  excludedCriteria: ExcludedCriterion[];
}

export interface ReportResult {
  score: number | null;
  sections: SectionResult[];
}

export function scoreSection(
  section: Section,
  signalValues: Record<string, unknown>,
): SectionResult {
  const active: Criterion[] = [];
  const excluded: ExcludedCriterion[] = [];

  for (const c of section.criteria) {
    const v = signalValues[c.signalType];
    if (v === null || v === undefined) {
      excluded.push({ name: c.name, reason: 'signal_null', originalWeight: c.weight });
    } else {
      active.push(c);
    }
  }

  if (active.length === 0) {
    return { name: section.name, declaredWeight: section.declaredWeight, score: null, excludedCriteria: excluded };
  }

  const totalActiveWeight = active.reduce((a, c) => a + c.weight, 0);
  const weightedScore = active.reduce((acc, c) => acc + c.scoreFn(signalValues[c.signalType]) * c.weight, 0);
  const score = weightedScore / totalActiveWeight;

  return { name: section.name, declaredWeight: section.declaredWeight, score, excludedCriteria: excluded };
}

export function scoreReport(
  sections: Section[],
  signalValues: Record<string, unknown>,
): ReportResult {
  const results = sections.map(s => scoreSection(s, signalValues));
  const nonNull = results.filter(r => r.score !== null);

  if (nonNull.length === 0) {
    return { score: null, sections: results };
  }

  const totalWeight = nonNull.reduce((a, r) => a + r.declaredWeight, 0);
  const weighted = nonNull.reduce((acc, r) => acc + (r.score as number) * r.declaredWeight, 0);

  return { score: weighted / totalWeight, sections: results };
}
```

**Note:** existing callers of the old `scoreReport` API may need adjustment; inspect via `grep -r "scoreReport\|scoreSection"` and update accordingly.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aide/evaluator test rubric/nullAwareWeight`
Expected: 8 tests pass

- [ ] **Step 5: Run existing rubric tests, adjust if signature changed**

Run: `pnpm --filter @aide/evaluator test rubric`
Fix any compile errors in callers by updating to new `SectionResult` / `ReportResult` shape.

- [ ] **Step 6: Commit**

```bash
git add packages/evaluator/src/rubric/evaluator.ts packages/evaluator/tests/rubric/nullAwareWeight.test.ts
git commit -m "feat(evaluator): null-aware weight redistribution in rubric scoring"
```

### Task 16.3: Platform rubric v2 JSON

**Files:**
- Create: `db/migrations/0006_rubric_v2.sql`
- Create: `db/migrations/0006_rubric_v2.down.sql`
- Create: `packages/evaluator/src/rubric/platformV2.ts`

- [ ] **Step 1: Write TS rubric v2 structure**

```typescript
// packages/evaluator/src/rubric/platformV2.ts
export const PLATFORM_RUBRIC_V2 = {
  version: 2,
  sections: [
    {
      name: 'Collaboration Quality',
      declaredWeight: 40,
      criteria: [
        { name: 'Iteration pattern', weight: 15, signalType: 'iteration_count' },
        { name: 'Refusal control', weight: 10, signalType: 'refusal_rate' },
        { name: 'Claude helpfulness', weight: 15, signalType: 'facet_claude_helpfulness' },
      ],
    },
    {
      name: 'Outcomes',
      declaredWeight: 60,
      criteria: [
        { name: 'Tool execution success', weight: 15, signalType: 'tool_success_rate' },
        { name: 'Session completion', weight: 15, signalType: 'completion_rate' },
        { name: 'Bugs caught', weight: 10, signalType: 'facet_bugs_caught' },
        { name: 'Friction signals', weight: 10, signalType: 'facet_friction_per_session', inverted: true },
        { name: 'Codex error rate', weight: 10, signalType: 'facet_codex_errors', inverted: true },
      ],
    },
  ],
};

export const PLATFORM_RUBRIC_V2_JSON = JSON.stringify(PLATFORM_RUBRIC_V2);
```

- [ ] **Step 2: Write up migration**

```sql
-- db/migrations/0006_rubric_v2.sql
BEGIN;

-- Keep a backup row with the pre-v2 rubric_json for emergency rollback.
CREATE TABLE IF NOT EXISTS rubrics_v1_backup (
  rubric_id UUID PRIMARY KEY,
  rubric_json JSONB NOT NULL,
  backed_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO rubrics_v1_backup (rubric_id, rubric_json)
  SELECT id, rubric_json FROM rubrics WHERE scope = 'platform'
  ON CONFLICT (rubric_id) DO NOTHING;

-- The v2 JSON is inlined below. Keep this in sync with packages/evaluator/src/rubric/platformV2.ts.
UPDATE rubrics
  SET rubric_json = '{"version":2,"sections":[{"name":"Collaboration Quality","declaredWeight":40,"criteria":[{"name":"Iteration pattern","weight":15,"signalType":"iteration_count"},{"name":"Refusal control","weight":10,"signalType":"refusal_rate"},{"name":"Claude helpfulness","weight":15,"signalType":"facet_claude_helpfulness"}]},{"name":"Outcomes","declaredWeight":60,"criteria":[{"name":"Tool execution success","weight":15,"signalType":"tool_success_rate"},{"name":"Session completion","weight":15,"signalType":"completion_rate"},{"name":"Bugs caught","weight":10,"signalType":"facet_bugs_caught"},{"name":"Friction signals","weight":10,"signalType":"facet_friction_per_session","inverted":true},{"name":"Codex error rate","weight":10,"signalType":"facet_codex_errors","inverted":true}]}]}'::jsonb,
      revision = revision + 1,
      updated_at = now()
  WHERE scope = 'platform' AND locale IN ('en','zh-Hant','ja');

COMMIT;
```

- [ ] **Step 3: Write down migration**

```sql
-- db/migrations/0006_rubric_v2.down.sql
BEGIN;

UPDATE rubrics r
  SET rubric_json = b.rubric_json,
      revision = r.revision + 1,
      updated_at = now()
  FROM rubrics_v1_backup b
  WHERE r.id = b.rubric_id AND r.scope = 'platform';

DROP TABLE IF EXISTS rubrics_v1_backup;

COMMIT;
```

- [ ] **Step 4: Write integration test**

Create `apps/api/tests/integration/migrations/0006.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestDb, applyMigrationsUpTo } from '../../helpers/db';

describe('migration 0006 rubric v2', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => { db = await createTestDb(); await applyMigrationsUpTo(db, '0006'); });

  it('updates 3 platform rubrics to v2', async () => {
    const rows = await db.many(`
      SELECT locale, rubric_json->>'version' AS version
      FROM rubrics WHERE scope = 'platform' ORDER BY locale
    `);
    expect(rows.map(r => r.locale)).toEqual(['en','ja','zh-Hant']);
    expect(rows.every(r => r.version === '2')).toBe(true);
  });

  it('backup table contains pre-v2 rubric_json', async () => {
    const { count } = await db.one(`SELECT COUNT(*)::int AS count FROM rubrics_v1_backup`);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('v2 rubric references facet_* signals', async () => {
    const r = await db.one(`SELECT rubric_json FROM rubrics WHERE locale='en' AND scope='platform'`);
    const criteria = r.rubric_json.sections.flatMap((s: any) => s.criteria.map((c: any) => c.signalType));
    expect(criteria).toContain('facet_claude_helpfulness');
    expect(criteria).toContain('facet_bugs_caught');
  });
});
```

- [ ] **Step 5: Apply and test**

Run: `pnpm --filter @aide/api migrate:up && pnpm --filter @aide/api test integration/migrations/0006`
Expected: 3 tests pass

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0006_rubric_v2.sql db/migrations/0006_rubric_v2.down.sql packages/evaluator/src/rubric/platformV2.ts apps/api/tests/integration/migrations/0006.test.ts
git commit -m "feat(db): migration 0006 platform rubric v2 (facet-augmented, backward compatible)"
```

---

## Part 17 — Report UI + Rubric editor + Banner + i18n

### Task 17.1: Banner component

**Files:**
- Create: `apps/web/src/components/evaluator/Banner.tsx`
- Test: `apps/web/tests/components/evaluator/Banner.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/tests/components/evaluator/Banner.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Banner } from '../../../src/components/evaluator/Banner';

describe('Banner', () => {
  it('renders info variant', () => {
    const { container } = render(<Banner variant="info">Info message</Banner>);
    expect(container.querySelector('.banner--info')).toBeTruthy();
    expect(screen.getByText('Info message')).toBeInTheDocument();
  });

  it('renders warn variant', () => {
    const { container } = render(<Banner variant="warn">Warning</Banner>);
    expect(container.querySelector('.banner--warn')).toBeTruthy();
  });

  it('renders error variant with role alert', () => {
    render(<Banner variant="error">Error</Banner>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aide/web test components/evaluator/Banner`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```tsx
// apps/web/src/components/evaluator/Banner.tsx
import { ReactNode } from 'react';

type Variant = 'info' | 'warn' | 'error';

export function Banner({ variant, children }: { variant: Variant; children: ReactNode }) {
  const role = variant === 'error' ? 'alert' : undefined;
  return (
    <div className={`banner banner--${variant}`} role={role}>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @aide/web test components/evaluator/Banner`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/evaluator/Banner.tsx apps/web/tests/components/evaluator/Banner.test.tsx
git commit -m "feat(web): Banner component (info/warn/error)"
```

### Task 17.2: Report page — excludedCriteria + degraded banner + facet drill-down

**Files:**
- Modify: `apps/web/src/components/evaluator/ProfileEvaluation.tsx`

- [ ] **Step 1: Add excludedCriteria rendering**

Locate the per-section rendering loop. After the list of active criteria, append:

```tsx
{section.excludedCriteria?.map((ex) => (
  <li key={ex.name} className="criterion criterion--excluded">
    <span aria-hidden="true">⊘</span>
    <span>{ex.name}</span>
    <span className="criterion__skip-note">
      {t('report.criterionSkipped', { weight: ex.originalWeight })}
    </span>
    <span className="criterion__reason">
      {t(`report.reason.${ex.reason}`)}
    </span>
  </li>
))}
```

- [ ] **Step 2: Add degraded banner**

At the top of the report view, before sections:

```tsx
{report.llm_degraded && (
  <Banner variant="warn">
    {t('report.degradedNotice')}{' '}
    <Link href="/admin/evaluator/costs">{t('report.viewCostDashboard')} →</Link>
  </Banner>
)}
```

- [ ] **Step 3: Add facet drill-down**

In the evidence drill-down section, when a session has a facet available, add:

```tsx
{session.facet && (
  <details className="evidence__facet">
    <summary>{t('report.evidence.facetSummary')}</summary>
    {session.facet.extraction_error ? (
      <p className="evidence__facet-error">
        {t('report.evidence.facetFailed', { error: session.facet.extraction_error })}
      </p>
    ) : (
      <dl>
        <div><dt>{t('report.evidence.type')}</dt><dd>{session.facet.session_type ?? '—'}</dd></div>
        <div><dt>{t('report.evidence.outcome')}</dt><dd>{session.facet.outcome ?? '—'}</dd></div>
        <div><dt>{t('report.evidence.helpfulness')}</dt><dd>{session.facet.claude_helpfulness ?? '—'}</dd></div>
        <div><dt>{t('report.evidence.friction')}</dt><dd>{session.facet.friction_count ?? '—'}</dd></div>
        <div><dt>{t('report.evidence.bugs')}</dt><dd>{session.facet.bugs_caught_count ?? '—'}</dd></div>
      </dl>
    )}
  </details>
)}
```

- [ ] **Step 4: Update tRPC payload to include facet**

Modify the report-retrieval tRPC endpoint (likely `apps/api/src/trpc/routers/evaluatorReport.ts`) so each session in the response carries its facet row (LEFT JOIN `request_body_facets`).

```typescript
// Inside the session-loading query:
const { rows } = await db.query(`
  SELECT rb.*, f.session_type, f.outcome, f.claude_helpfulness,
         f.friction_count, f.bugs_caught_count, f.codex_errors_count,
         f.extraction_error
  FROM request_bodies rb
  LEFT JOIN request_body_facets f ON f.request_body_id = rb.id
  WHERE rb.member_id = $1 AND rb.created_at >= $2
`, [memberId, windowStart]);
```

Return each row's facet as a nested `facet` object when any facet column is non-null or the error field is present.

- [ ] **Step 5: Add i18n keys**

Add to `apps/web/src/i18n/{en,zh-Hant,ja}.json`:
- `report.criterionSkipped`
- `report.reason.signal_null`
- `report.degradedNotice`
- `report.viewCostDashboard`
- `report.evidence.facetSummary`
- `report.evidence.facetFailed`
- `report.evidence.type` / `.outcome` / `.helpfulness` / `.friction` / `.bugs`

- [ ] **Step 6: Manual smoke**

`pnpm --filter @aide/web dev` → view a report with excluded criteria → verify display. Trigger an evaluation with facet enabled → view evidence drill-down.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/evaluator/ProfileEvaluation.tsx apps/api/src/trpc/routers/evaluatorReport.ts apps/web/src/i18n/
git commit -m "feat(web): report page excluded criteria + degraded banner + facet drill-down"
```

### Task 17.3: Rubric editor — facet signal group + dry-run warnings

**Files:**
- Modify: `apps/web/src/components/evaluator/RubricEditor.tsx`

- [ ] **Step 1: Group signal types in dropdown**

```tsx
const SIGNAL_GROUPS = {
  'builtin': {
    label: t('rubric.signalGroup.builtin'),
    options: ['iteration_count', 'refusal_rate', 'tool_success_rate', 'completion_rate'],
  },
  'facet': {
    label: t('rubric.signalGroup.facet'),
    badge: t('rubric.signalGroup.facetBadge'),  // "Requires facet extraction"
    options: ['facet_claude_helpfulness', 'facet_friction_per_session', 'facet_bugs_caught', 'facet_codex_errors', 'facet_outcome_success_rate', 'facet_session_type_ratio'],
  },
};

<select {...register('signalType')}>
  <optgroup label={SIGNAL_GROUPS.builtin.label}>
    {SIGNAL_GROUPS.builtin.options.map(s => <option key={s} value={s}>{s}</option>)}
  </optgroup>
  <optgroup label={`${SIGNAL_GROUPS.facet.label} — ${SIGNAL_GROUPS.facet.badge}`}>
    {SIGNAL_GROUPS.facet.options.map(s => <option key={s} value={s}>{s}</option>)}
  </optgroup>
</select>
```

- [ ] **Step 2: Dry-run warning for facet criteria**

In the dry-run result rendering:

```tsx
{dryRunResult?.sections.map(section => (
  <div key={section.name}>
    <h3>{section.name}: {section.score ?? '—'}</h3>
    {section.excludedCriteria.length > 0 && (
      <Banner variant="info">
        {t('rubric.dryRun.excludedWarning', {
          criteria: section.excludedCriteria.map(c => c.name).join(', '),
        })}
      </Banner>
    )}
  </div>
))}
```

- [ ] **Step 3: Add i18n keys**

Add `rubric.signalGroup.builtin`, `rubric.signalGroup.facet`, `rubric.signalGroup.facetBadge`, `rubric.dryRun.excludedWarning`.

- [ ] **Step 4: Manual smoke**

Open rubric editor, select a facet signal, run dry-run against an org without facet enabled, verify warning appears.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/evaluator/RubricEditor.tsx apps/web/src/i18n/
git commit -m "feat(web): rubric editor — grouped signals + facet dry-run warning"
```

---

## Part 18 — E2E specs + CI guards + documentation wrap-up

### Task 18.1: E2E — cost dashboard

**Files:**
- Create: `apps/web/e2e/specs/30-cost-dashboard.spec.ts`

- [ ] **Step 1: Write spec**

```typescript
// apps/web/e2e/specs/30-cost-dashboard.spec.ts
import { test, expect } from '@playwright/test';
import { loginAsAdmin, seedOrg, resetTestDb } from '../helpers';

test.describe('Cost dashboard', () => {
  test.beforeEach(async () => {
    await resetTestDb();
    await seedOrg({ llm_monthly_budget_usd: 50 });
  });

  test('admin sees widget on home, navigates to full dashboard', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin');
    await expect(page.locator('.cost-widget')).toBeVisible();
    await page.locator('.cost-widget').click();
    await expect(page).toHaveURL(/\/admin\/evaluator\/costs/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.cost-summary-card')).toBeVisible();
  });

  test('shows unlimited when budget is null', async ({ page }) => {
    await resetTestDb();
    await seedOrg({ llm_monthly_budget_usd: null });
    await loginAsAdmin(page);
    await page.goto('/admin/evaluator/costs');
    await expect(page.getByText(/unlimited/i)).toBeVisible();
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/e2e/specs/30-cost-dashboard.spec.ts
git commit -m "test(e2e): cost dashboard navigation + unlimited state"
```

### Task 18.2: E2E — budget setting + warning

**Files:**
- Create: `apps/web/e2e/specs/31-budget-setting.spec.ts`

- [ ] **Step 1: Write spec**

```typescript
// apps/web/e2e/specs/31-budget-setting.spec.ts
import { test, expect } from '@playwright/test';
import { loginAsAdmin, seedOrg, resetTestDb } from '../helpers';

test.describe('Budget setting & warning', () => {
  test.beforeEach(async () => {
    await resetTestDb();
    await seedOrg({ llm_eval_enabled: true, llm_monthly_budget_usd: null });
  });

  test('setting budget clears no-budget warning', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/evaluator/settings');

    await expect(page.locator('.banner--warn')).toContainText(/no budget set/i);

    await page.fill('input[name="llm_monthly_budget_usd"]', '10');
    await page.click('button[type="submit"]');

    await expect(page.locator('.banner--warn')).toHaveCount(0);
  });

  test('clearing budget shows warning again', async ({ page }) => {
    await resetTestDb();
    await seedOrg({ llm_eval_enabled: true, llm_monthly_budget_usd: 10 });
    await loginAsAdmin(page);
    await page.goto('/admin/evaluator/settings');

    await page.fill('input[name="llm_monthly_budget_usd"]', '');
    await page.click('button[type="submit"]');

    await expect(page.locator('.banner--warn')).toBeVisible();
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/e2e/specs/31-budget-setting.spec.ts
git commit -m "test(e2e): budget setting dynamic warning"
```

### Task 18.3: E2E — facet enable + report drill-down

**Files:**
- Create: `apps/web/e2e/specs/32-facet-enable.spec.ts`

- [ ] **Step 1: Write spec**

```typescript
// apps/web/e2e/specs/32-facet-enable.spec.ts
import { test, expect } from '@playwright/test';
import { loginAsAdmin, seedOrg, triggerEvaluator, resetTestDb } from '../helpers';

test.describe('Facet enable + report drill-down', () => {
  test.beforeEach(async () => {
    await resetTestDb();
    await seedOrg({
      llm_eval_enabled: true, llm_eval_model: 'claude-haiku-4-5',
      llm_monthly_budget_usd: 50,
    });
    process.env.ENABLE_FACET_EXTRACTION = 'true';
  });

  test('enable facet, trigger evaluator, view drill-down', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/evaluator/settings');

    await page.check('input[name="llm_facet_enabled"]');
    await page.selectOption('select[name="llm_facet_model"]', 'claude-haiku-4-5');
    await page.click('button[type="submit"]');

    await triggerEvaluator();

    await page.goto('/admin/evaluator/reports');
    await page.click('.report-row:first-child');
    await page.click('details.evidence__facet summary');
    await expect(page.locator('.evidence__facet dl')).toBeVisible();
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/e2e/specs/32-facet-enable.spec.ts
git commit -m "test(e2e): enable facet, trigger evaluator, view drill-down"
```

### Task 18.4: E2E — rubric editor facet signal + dry-run warning

**Files:**
- Create: `apps/web/e2e/specs/33-rubric-facet-signal.spec.ts`

- [ ] **Step 1: Write spec**

```typescript
// apps/web/e2e/specs/33-rubric-facet-signal.spec.ts
import { test, expect } from '@playwright/test';
import { loginAsAdmin, seedOrg, resetTestDb } from '../helpers';

test.describe('Rubric editor facet signals', () => {
  test.beforeEach(async () => {
    await resetTestDb();
    await seedOrg({ llm_facet_enabled: false });
  });

  test('dry-run shows excluded-criterion warning for facet signal', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/evaluator/rubrics');
    await page.click('button:has-text("New rubric")');

    await page.selectOption('select[name="criteria.0.signalType"]', 'facet_bugs_caught');
    await page.fill('input[name="criteria.0.weight"]', '50');

    await page.click('button:has-text("Dry-run")');

    await expect(page.locator('.banner--info')).toContainText(/excluded|redistributed/i);
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/e2e/specs/33-rubric-facet-signal.spec.ts
git commit -m "test(e2e): rubric editor facet signal dry-run warning"
```

### Task 18.5: E2E — degraded banner

**Files:**
- Create: `apps/web/e2e/specs/34-degraded-banner.spec.ts`

- [ ] **Step 1: Write spec (seeds ledger via SQL per D12)**

```typescript
// apps/web/e2e/specs/34-degraded-banner.spec.ts
import { test, expect } from '@playwright/test';
import { loginAsAdmin, seedOrg, seedMember, seedRequestBody, triggerEvaluator, resetTestDb, runSql } from '../helpers';

test.describe('Degraded banner', () => {
  test('shows banner when budget exhausted', async ({ page }) => {
    await resetTestDb();
    const orgId = await seedOrg({
      llm_eval_enabled: true, llm_eval_model: 'claude-haiku-4-5',
      llm_monthly_budget_usd: 1,
      llm_budget_overage_behavior: 'degrade',
    });
    const memberId = await seedMember({ orgId });
    await seedRequestBody({ orgId, memberId });

    // Seed ledger with near-budget spend (D12: use SQL, no test-only endpoint)
    await runSql(`
      INSERT INTO llm_usage_events (org_id, event_type, model, tokens_input, tokens_output, cost_usd)
      VALUES ('${orgId}', 'deep_analysis', 'claude-haiku-4-5', 1, 1, 0.99)
    `);

    await triggerEvaluator();

    await loginAsAdmin(page);
    await page.goto('/admin/evaluator/reports');
    await page.click('.report-row:first-child');

    await expect(page.locator('.banner--warn')).toContainText(/budget|degraded/i);
    await expect(page.getByRole('link', { name: /cost dashboard/i })).toBeVisible();
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/e2e/specs/34-degraded-banner.spec.ts
git commit -m "test(e2e): degraded banner visible when budget exhausted"
```

### Task 18.6: CI — no-anthropic-calls guard

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add guard step**

In the CI workflow, add a new job (or step inside an existing job):

```yaml
  no-external-calls:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Ensure no direct Anthropic SDK imports in tests
        run: |
          if grep -r --include='*.ts' --include='*.tsx' "from '@anthropic-ai/sdk'" apps/*/tests packages/*/tests ; then
            echo "Tests must not import @anthropic-ai/sdk directly. Use MSW mocks."
            exit 1
          fi
      - name: Ensure ANTHROPIC_API_KEY is a test placeholder
        run: |
          grep -q 'ANTHROPIC_API_KEY:.*test-key-do-not-use' .github/workflows/ci.yml
```

Ensure the test env injection uses `test-key-do-not-use`:

```yaml
env:
  ANTHROPIC_API_KEY: test-key-do-not-use
```

- [ ] **Step 2: Bump BullMQ test timeout**

Update the `test` job's Vitest timeout env or config:

```yaml
env:
  VITEST_TEST_TIMEOUT: 300000
```

Or modify `vitest.config.ts` in `apps/gateway/`:

```typescript
test: {
  testTimeout: 300000,
  hookTimeout: 300000,
  // …
}
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml apps/gateway/vitest.config.ts
git commit -m "ci: add no-external-calls guard + bump BullMQ test timeout"
```

### Task 18.7: UPGRADE-v0.5.0.md

**Files:**
- Create: `docs/UPGRADE-v0.5.0.md`

- [ ] **Step 1: Write upgrade guide**

```markdown
# Upgrading to AIDE v0.5.0

## Highlights

- **Observability**: Grafana dashboards, Prometheus alerts, 8 runbooks
- **Cost control**: Per-org monthly LLM budget with degrade/halt enforcement
- **LLM facet extraction** (opt-in): recovers CLI-parity signals like `bugsCaught`, `frictionSessions`
- **Platform rubric v2**: facet-augmented scoring with null-aware weight redistribution

## Breaking changes

- **Web Docker image no longer publishes arm64.** amd64 only. Self-build if you need arm64:
  `docker buildx build --platform linux/arm64 ./docker/Dockerfile.web`

## Step-by-step

1. **Backup your database**
   \`\`\`bash
   pg_dump $DATABASE_URL > aide-v0.4.0-backup.sql
   \`\`\`

2. **Pull new images**
   \`\`\`bash
   docker-compose pull
   \`\`\`

3. **Bring up the stack** (migrations 0004 → 0005 → 0006 run automatically)
   \`\`\`bash
   docker-compose up -d
   \`\`\`

4. **Verify Settings displays new fields**
   Log in as org admin → Evaluator → Settings. You should see:
   - "LLM Cost Control" fieldset (budget, overage behavior)
   - "LLM Facet Extraction" fieldset

5. **(Optional) Set a monthly budget**
   Enter a USD amount. Leave empty for unlimited. We strongly recommend setting a budget.

6. **(Optional) Enable facet extraction**
   - Check "Enable facet extraction"
   - Choose `claude-haiku-4-5` (recommended for cost)
   - Set `ENABLE_FACET_EXTRACTION=true` in gateway env
   - Restart gateway

7. **Verify cost dashboard**
   Navigate to Admin → Costs (or click the widget on the admin home).
   You should see this month's spend, budget, and breakdowns.

8. **(If you run Grafana) Install dashboards**
   \`\`\`bash
   cp ops/grafana/*.json /var/lib/grafana/dashboards/
   sudo systemctl restart grafana-server
   \`\`\`

9. **(If you run Alertmanager) Merge alert rules**
   \`\`\`bash
   cp ops/prometheus/alerts.yml /etc/prometheus/rules/aide.yml
   cp ops/alertmanager/alertmanager.yml.example ops/alertmanager/alertmanager.yml
   # Edit ops/alertmanager/alertmanager.yml to add your Slack/Discord webhook
   \`\`\`

## Rollback

If something goes wrong:

1. **Feature flag rollback (preferred, 95% of cases)**:
   \`\`\`bash
   # In gateway env:
   ENABLE_FACET_EXTRACTION=false
   # Restart gateway
   \`\`\`

2. **Per-org rollback**:
   \`\`\`sql
   UPDATE organizations
     SET llm_facet_enabled = false, llm_monthly_budget_usd = NULL
     WHERE id = '<org-id>';
   \`\`\`

3. **Rubric rollback**:
   \`\`\`sql
   -- Use the backup table created by migration 0006
   UPDATE rubrics r
     SET rubric_json = b.rubric_json
     FROM rubrics_v1_backup b
     WHERE r.id = b.rubric_id AND r.scope = 'platform';
   \`\`\`

4. **Full Docker rollback**:
   \`\`\`bash
   docker-compose down
   # Edit docker-compose.yml image tags: aide-*:v0.4.0
   # Run down migrations in order: 0006 → 0005 → 0004
   psql $DATABASE_URL -f db/migrations/0006_rubric_v2.down.sql
   psql $DATABASE_URL -f db/migrations/0005_facet_table.down.sql
   psql $DATABASE_URL -f db/migrations/0004_cost_infra.down.sql
   docker-compose up -d
   \`\`\`

## Observing after upgrade

After 24 hours, check:
- `gw_eval_job_failed_total` rate matches v0.4.0 baseline (no regression)
- No `LLMBudgetExceeded` alerts unless expected
- Cost dashboard renders real data

## Questions?

Open a GitHub issue with label `v0.5.0` and we'll help.
```

- [ ] **Step 2: Commit**

```bash
git add docs/UPGRADE-v0.5.0.md
git commit -m "docs: UPGRADE-v0.5.0.md with step-by-step and rollback"
```

### Task 18.8: Update EVALUATOR.md + README

**Files:**
- Modify: `docs/EVALUATOR.md`
- Modify: `README.md`

- [ ] **Step 1: EVALUATOR.md — add Cost + Facet sections**

Append new sections to `docs/EVALUATOR.md`:

```markdown
## LLM Cost Control

Every org has a monthly budget knob on Settings:

- `llm_monthly_budget_usd` — USD. Leave empty for unlimited.
- `llm_budget_overage_behavior` — `degrade` (skip LLM calls) or `halt` (stop all LLM until next month).

The gateway tracks every LLM call in the `llm_usage_events` ledger. Before each call, `enforceBudget()` checks monthly spend against budget.

Admins view spend on `/admin/evaluator/costs`.

See `docs/runbooks/llm-budget.md` for alert runbooks.

## LLM Facet Extraction

Off by default. When enabled, the evaluator calls the configured facet model (recommend `claude-haiku-4-5`) on each session before rule-based scoring, extracting:

- `sessionType`: feature_dev | bug_fix | refactor | exploration | other
- `outcome`: success | partial | failure | abandoned
- `claudeHelpfulness`: 1-5
- `frictionCount`, `bugsCaughtCount`, `codexErrorsCount`: non-negative integers

Facets are stored in `request_body_facets` keyed on `request_body_id`. They are aggregated into `facet_*` signals consumed by platform rubric v2.

Enable flow:
1. Org admin: Settings → enable `llm_facet_enabled`, choose model
2. Platform operator: set `ENABLE_FACET_EXTRACTION=true` in gateway env
3. Next daily evaluator cron will extract facets for recent sessions

See `docs/runbooks/facet-extraction.md` for failure-rate alerts.
```

- [ ] **Step 2: README — feature list update**

Edit README's feature list to mention cost control + facet extraction. Update image matrix per Task 12.3.

- [ ] **Step 3: Commit**

```bash
git add docs/EVALUATOR.md README.md
git commit -m "docs: document cost control + facet extraction + image matrix"
```

### Task 18.9: Version bump + release branch cut

**Files:**
- Modify: `package.json` and subpackage `package.json` files
- Modify: `docker-compose.yml` (if it pins image tags)
- Modify: `.github/workflows/release.yml` (ensure triggered by v0.5.0 tag)

- [ ] **Step 1: Bump version**

Run (from repo root):

```bash
# Adjust this command to your monorepo's versioning tool (e.g. changesets, manual edit)
pnpm -r exec -- npm version 0.5.0 --no-git-tag-version
```

Verify root `package.json` and every `apps/*/package.json` / `packages/*/package.json` show `"version": "0.5.0"`.

- [ ] **Step 2: Update docker-compose pinning (if applicable)**

If docker-compose.yml pins exact tags, bump them:

```yaml
services:
  api:
    image: ghcr.io/hanfour/aide-api:v0.5.0
```

- [ ] **Step 3: Commit**

```bash
git add package.json apps/*/package.json packages/*/package.json docker-compose.yml
git commit -m "chore: bump version to 0.5.0"
```

- [ ] **Step 4: Final self-check before tag**

Before proceeding to tag (done per spec Stage 4, only after Stage 3 canary):

- Run full CI locally: `pnpm test && pnpm --filter @aide/web exec playwright test`
- Verify migrations 0004, 0005, 0006 apply cleanly
- Verify self-org has been running Phase 2 for ≥ 7 days with metrics green

Do **not** tag until spec Stage 3 success criteria are met (§13).

---

## Appendix A — Running the plan

**Recommended execution mode:** subagent-driven. Each part has 2-6 tasks; spawn one subagent per task with review between tasks.

**Phase boundaries:** after Part 12, pause for canary observation per spec Stage 1. After Part 18, pause for canary observation per spec Stage 3.

**Git workflow:** each task commits; each part may be reviewed as a group PR or merged via multiple small PRs.

## Appendix B — Spec-task traceability

| Spec section | Plan parts |
|--------------|------------|
| §5 Schema changes | Parts 1, 13, 16.3 |
| §6 Cost budget infra | Parts 2, 3, 4 |
| §7 Facet extractor | Parts 14, 15 |
| §8 Rubric + signals | Part 16 |
| §9.1-9.4 Observability | Parts 7, 8, 9, 10 |
| §9.5 Post-release smoke | Part 11 |
| §9.6 SSE test | Part 12.1-12.2 |
| §9.7 Arm64 change | Part 12.3 |
| §10 Admin UI | Parts 5, 6, 17 |
| §11 Migration + deployment | Parts 1, 13, 16.3, 18.9 |
| §12 Testing | Distributed across every part; §18 E2E + CI |
| §13 Rollout stages | Enforced by pause points in Appendix A |












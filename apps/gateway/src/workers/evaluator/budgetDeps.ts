/**
 * Concrete budget deps for the gateway evaluator worker (Plan 4C, Task 3.2).
 *
 * Wires the abstract `EnforceBudgetDeps` interface from `@aide/evaluator` to
 * a real Drizzle/Postgres `Database`, so the worker can call `enforceBudget`
 * with production storage.
 *
 * Wiring:
 *   - loadOrg       → SELECT from `organizations` (snake_case shape)
 *   - getMonthSpend → SUM(`cost_usd`) from `llm_usage_events` for the org
 *                     where monthStart <= created_at < nextMonthStart
 *                     (upper bound prevents leaking future-month rows; defensive)
 *   - setHalt       → UPDATE organizations SET llm_halted_until_month_end = true
 *   - clearHalt     → UPDATE organizations SET llm_halted_until_month_end = false
 *   - now           → wall clock
 *
 * Notes:
 *   - `halt_set_at` is intentionally returned as `undefined`. The `organizations`
 *     table currently lacks a dedicated `llm_halted_at` column, so we cannot
 *     accurately track when the halt was set. As a result, once the halt flag
 *     flips on, it remains on until manually cleared (it will not auto-clear
 *     when the month rolls over). This is a known v0.5.0 limitation; an admin
 *     can clear the flag via SQL or a future UI button. A follow-up task will
 *     add `llm_halted_at` and remove this caveat.
 *     TODO(plan-4c-followup): add `llm_halted_at timestamptz` column and
 *     populate it in setHalt; surface it here as `halt_set_at`.
 */

import { and, eq, gte, lt, sum } from "drizzle-orm";
import type { Database } from "@aide/db";
import { llmUsageEvents, organizations } from "@aide/db";
import type { EnforceBudgetDeps } from "@aide/evaluator";

const DEFAULT_OVERAGE_BEHAVIOR = "degrade" as const;

/**
 * Build a concrete `EnforceBudgetDeps` bound to the given Drizzle `Database`.
 *
 * The returned deps object is itself immutable — callers should not mutate
 * its members. Each call creates a fresh closure over `db`.
 */
export function createBudgetDeps(db: Database): EnforceBudgetDeps {
  return {
    async loadOrg(orgId) {
      const rows = await db
        .select({
          id: organizations.id,
          llmMonthlyBudgetUsd: organizations.llmMonthlyBudgetUsd,
          llmBudgetOverageBehavior: organizations.llmBudgetOverageBehavior,
          llmHaltedUntilMonthEnd: organizations.llmHaltedUntilMonthEnd,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);

      const row = rows[0];
      if (!row) {
        throw new Error(`Org not found: ${orgId}`);
      }

      const behavior =
        row.llmBudgetOverageBehavior === "halt"
          ? "halt"
          : DEFAULT_OVERAGE_BEHAVIOR;

      return {
        id: row.id,
        llm_monthly_budget_usd:
          row.llmMonthlyBudgetUsd == null
            ? null
            : Number(row.llmMonthlyBudgetUsd),
        llm_budget_overage_behavior: behavior,
        llm_halted_until_month_end: row.llmHaltedUntilMonthEnd,
        // See file header: column does not yet exist.
        halt_set_at: undefined,
      };
    },

    async getMonthSpend(orgId, monthStart) {
      // Compute the start of the *next* UTC month to use as an exclusive upper
      // bound. Without this bound, a clock-skewed or backfilled future row
      // would inflate the current month's spend.
      const nextMonthStart = new Date(
        Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1),
      );

      const rows = await db
        .select({ total: sum(llmUsageEvents.costUsd) })
        .from(llmUsageEvents)
        .where(
          and(
            eq(llmUsageEvents.orgId, orgId),
            gte(llmUsageEvents.createdAt, monthStart),
            lt(llmUsageEvents.createdAt, nextMonthStart),
          ),
        );

      const total = rows[0]?.total;
      if (total == null) {
        return 0;
      }
      const parsed = Number(total);
      return Number.isFinite(parsed) ? parsed : 0;
    },

    async setHalt(orgId) {
      await db
        .update(organizations)
        .set({ llmHaltedUntilMonthEnd: true })
        .where(eq(organizations.id, orgId));
    },

    async clearHalt(orgId) {
      await db
        .update(organizations)
        .set({ llmHaltedUntilMonthEnd: false })
        .where(eq(organizations.id, orgId));
    },

    now: () => new Date(),
  };
}

import { BudgetExceededDegrade, BudgetExceededHalt } from "./errors";

export interface OrgBudgetState {
  id: string;
  llm_monthly_budget_usd: number | null;
  llm_budget_overage_behavior: "degrade" | "halt";
  llm_halted_until_month_end: boolean;
  halt_set_at?: Date;
}

export interface EnforceBudgetDeps {
  loadOrg: (orgId: string) => Promise<OrgBudgetState>;
  getMonthSpend: (orgId: string, monthStart: Date) => Promise<number>;
  setHalt: (orgId: string) => Promise<void>;
  clearHalt: (orgId: string) => Promise<void>;
  now: () => Date;
}

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function sameMonth(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth()
  );
}

export async function enforceBudget(
  orgId: string,
  estimatedCost: number,
  deps: EnforceBudgetDeps,
): Promise<void> {
  const org = await deps.loadOrg(orgId);
  const now = deps.now();

  // Halt flag: if set this same month, throw immediately. If from a prior month, clear and continue.
  if (org.llm_halted_until_month_end) {
    if (org.halt_set_at && sameMonth(org.halt_set_at, now)) {
      // We're already halted — query actual spend so error logs are honest
      // about the current state (rather than passing the budget as spend).
      const currentSpend = await deps.getMonthSpend(orgId, monthStartUtc(now));
      throw new BudgetExceededHalt({
        orgId,
        estimatedCost,
        currentSpend,
        budget: org.llm_monthly_budget_usd ?? 0,
      });
    }
    await deps.clearHalt(orgId);
  }

  // Unlimited
  if (org.llm_monthly_budget_usd == null) {
    return;
  }

  const currentSpend = await deps.getMonthSpend(orgId, monthStartUtc(now));

  if (currentSpend + estimatedCost <= org.llm_monthly_budget_usd) {
    return;
  }

  // Over budget
  const ctx = {
    orgId,
    estimatedCost,
    currentSpend,
    budget: org.llm_monthly_budget_usd,
  };

  if (org.llm_budget_overage_behavior === "halt") {
    await deps.setHalt(orgId);
    throw new BudgetExceededHalt(ctx);
  }
  throw new BudgetExceededDegrade(ctx);
}

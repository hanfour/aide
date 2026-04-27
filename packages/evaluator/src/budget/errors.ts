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
    super(
      `Budget would be exceeded (degrade): spend=${ctx.currentSpend} + est=${ctx.estimatedCost} > budget=${ctx.budget}`,
    );
    this.name = "BudgetExceededDegrade";
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
    this.name = "BudgetExceededHalt";
    this.orgId = ctx.orgId;
    this.estimatedCost = ctx.estimatedCost;
    this.currentSpend = ctx.currentSpend;
    this.budget = ctx.budget;
  }
}

export function isBudgetError(
  e: unknown,
): e is BudgetExceededDegrade | BudgetExceededHalt {
  return e instanceof BudgetExceededDegrade || e instanceof BudgetExceededHalt;
}

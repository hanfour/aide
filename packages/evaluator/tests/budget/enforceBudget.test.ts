import { describe, it, expect, vi, beforeEach } from "vitest";
import { enforceBudget } from "../../src/budget/enforceBudget";
import type { EnforceBudgetDeps } from "../../src/budget/enforceBudget";
import {
  BudgetExceededDegrade,
  BudgetExceededHalt,
} from "../../src/budget/errors";

type LoadOrgFn = EnforceBudgetDeps["loadOrg"];
type GetMonthSpendFn = EnforceBudgetDeps["getMonthSpend"];
type SetHaltFn = EnforceBudgetDeps["setHalt"];
type ClearHaltFn = EnforceBudgetDeps["clearHalt"];

interface OrgState {
  id: string;
  llm_monthly_budget_usd: number | null;
  llm_budget_overage_behavior: "degrade" | "halt";
  llm_halted_until_month_end: boolean;
  halt_set_at?: Date;
}

describe("enforceBudget", () => {
  let mockLoadOrg: ReturnType<typeof vi.fn<LoadOrgFn>>;
  let mockGetMonthSpend: ReturnType<typeof vi.fn<GetMonthSpendFn>>;
  let mockSetHalt: ReturnType<typeof vi.fn<SetHaltFn>>;
  let mockClearHalt: ReturnType<typeof vi.fn<ClearHaltFn>>;
  let now: Date;

  beforeEach(() => {
    mockLoadOrg = vi.fn<LoadOrgFn>();
    mockGetMonthSpend = vi.fn<GetMonthSpendFn>();
    mockSetHalt = vi.fn<SetHaltFn>().mockResolvedValue(undefined);
    mockClearHalt = vi.fn<ClearHaltFn>().mockResolvedValue(undefined);
    now = new Date("2026-04-15T12:00:00Z");
  });

  const baseOrg: OrgState = {
    id: "org-1",
    llm_monthly_budget_usd: 50,
    llm_budget_overage_behavior: "degrade",
    llm_halted_until_month_end: false,
  };

  const deps = (): EnforceBudgetDeps => ({
    loadOrg: mockLoadOrg,
    getMonthSpend: mockGetMonthSpend,
    setHalt: mockSetHalt,
    clearHalt: mockClearHalt,
    now: () => now,
  });

  const call = (estCost: number, overrides: Partial<OrgState> = {}) => {
    mockLoadOrg.mockResolvedValue({ ...baseOrg, ...overrides });
    return enforceBudget("org-1", estCost, deps());
  };

  it("passes when budget is NULL (unlimited) — does not check spend", async () => {
    await expect(
      call(10, { llm_monthly_budget_usd: null }),
    ).resolves.toBeUndefined();
    expect(mockGetMonthSpend).not.toHaveBeenCalled();
  });

  it("passes when spend + est is within budget", async () => {
    mockGetMonthSpend.mockResolvedValue(20);
    await expect(call(10)).resolves.toBeUndefined();
  });

  it("passes when spend + est equals budget exactly", async () => {
    mockGetMonthSpend.mockResolvedValue(40);
    await expect(call(10)).resolves.toBeUndefined();
  });

  it("throws BudgetExceededDegrade when over and behavior=degrade", async () => {
    mockGetMonthSpend.mockResolvedValue(49);
    await expect(call(5)).rejects.toBeInstanceOf(BudgetExceededDegrade);
    expect(mockSetHalt).not.toHaveBeenCalled();
  });

  it("throws BudgetExceededHalt and sets halt flag when behavior=halt", async () => {
    mockGetMonthSpend.mockResolvedValue(49);
    await expect(
      call(5, { llm_budget_overage_behavior: "halt" }),
    ).rejects.toBeInstanceOf(BudgetExceededHalt);
    expect(mockSetHalt).toHaveBeenCalledWith("org-1");
  });

  it("throws BudgetExceededHalt immediately when halt flag is set this same month", async () => {
    await expect(
      call(5, {
        llm_halted_until_month_end: true,
        halt_set_at: new Date("2026-04-10T00:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(BudgetExceededHalt);

    // shouldn't even check spend
    expect(mockGetMonthSpend).not.toHaveBeenCalled();
    // shouldn't call setHalt again (already halted)
    expect(mockSetHalt).not.toHaveBeenCalled();
  });

  it("auto-clears halt flag and re-evaluates when a new month has begun", async () => {
    now = new Date("2026-05-01T00:30:00Z");
    mockGetMonthSpend.mockResolvedValue(0);
    await expect(
      call(5, {
        llm_halted_until_month_end: true,
        halt_set_at: new Date("2026-04-20T00:00:00Z"),
      }),
    ).resolves.toBeUndefined();

    expect(mockClearHalt).toHaveBeenCalledWith("org-1");
    expect(mockGetMonthSpend).toHaveBeenCalled();
  });

  it("preserves halt flag across days within same month", async () => {
    now = new Date("2026-04-30T23:59:00Z");
    await expect(
      call(5, {
        llm_halted_until_month_end: true,
        halt_set_at: new Date("2026-04-05T00:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(BudgetExceededHalt);

    expect(mockClearHalt).not.toHaveBeenCalled();
  });

  it("queries getMonthSpend with the start of current UTC month", async () => {
    now = new Date("2026-04-15T12:34:56Z");
    mockGetMonthSpend.mockResolvedValue(0);
    await call(1);

    const callArgs = mockGetMonthSpend.mock.calls[0]!;
    expect(callArgs[0]).toBe("org-1");
    const monthStart = callArgs[1] as Date;
    expect(monthStart.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
});

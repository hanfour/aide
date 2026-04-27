import { describe, it, expect } from "vitest";
import {
  BudgetExceededDegrade,
  BudgetExceededHalt,
  isBudgetError,
} from "../../src/budget/errors";

describe("BudgetExceededDegrade", () => {
  it("carries orgId, estimatedCost, currentSpend, budget", () => {
    const e = new BudgetExceededDegrade({
      orgId: "org-1",
      estimatedCost: 0.05,
      currentSpend: 49.99,
      budget: 50,
    });
    expect(e.name).toBe("BudgetExceededDegrade");
    expect(e.orgId).toBe("org-1");
    expect(e.estimatedCost).toBe(0.05);
    expect(e.currentSpend).toBe(49.99);
    expect(e.budget).toBe(50);
    expect(e).toBeInstanceOf(Error);
  });

  it("has a descriptive message", () => {
    const e = new BudgetExceededDegrade({
      orgId: "o", estimatedCost: 1, currentSpend: 49, budget: 50,
    });
    expect(e.message).toMatch(/budget/i);
    expect(e.message).toMatch(/49/);
    expect(e.message).toMatch(/50/);
  });
});

describe("BudgetExceededHalt", () => {
  it("is distinguishable from Degrade", () => {
    const h = new BudgetExceededHalt({
      orgId: "org-2", estimatedCost: 1, currentSpend: 50, budget: 50,
    });
    expect(h).toBeInstanceOf(BudgetExceededHalt);
    expect(h).not.toBeInstanceOf(BudgetExceededDegrade);
    expect(h.name).toBe("BudgetExceededHalt");
  });

  it("has a halt-specific message", () => {
    const h = new BudgetExceededHalt({
      orgId: "o", estimatedCost: 1, currentSpend: 50, budget: 50,
    });
    expect(h.message).toMatch(/halt/i);
  });
});

describe("isBudgetError type guard", () => {
  it("returns true for BudgetExceededDegrade", () => {
    expect(isBudgetError(new BudgetExceededDegrade({
      orgId: "a", estimatedCost: 1, currentSpend: 1, budget: 1,
    }))).toBe(true);
  });

  it("returns true for BudgetExceededHalt", () => {
    expect(isBudgetError(new BudgetExceededHalt({
      orgId: "a", estimatedCost: 1, currentSpend: 1, budget: 1,
    }))).toBe(true);
  });

  it("returns false for generic Error", () => {
    expect(isBudgetError(new Error("other"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isBudgetError(null)).toBe(false);
    expect(isBudgetError("string")).toBe(false);
    expect(isBudgetError({ name: "fake" })).toBe(false);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock the tRPC client *before* importing the component under test so the
// component's `import { trpc } from "@/lib/trpc/client"` resolves to the mock.
vi.mock("@/lib/trpc/client", () => ({
  trpc: {
    evaluator: {
      costSummary: {
        useQuery: vi.fn(),
      },
    },
  },
}));

import { CostSummaryCard } from "@/components/evaluator/CostSummaryCard";
import { trpc } from "@/lib/trpc/client";

// Cast to the vitest mock shape so we can configure return values per test.
const useQuery = trpc.evaluator.costSummary.useQuery as unknown as ReturnType<
  typeof vi.fn
>;

const baseData = {
  currentMonthSpendUsd: 12.34,
  budgetUsd: 50,
  remainingUsd: 37.66,
  projectedEndOfMonthUsd: 18.5,
  breakdown: {
    facetExtraction: { calls: 0, costUsd: 0 },
    deepAnalysis: { calls: 0, costUsd: 0 },
  },
  breakdownByModel: [],
  historicalMonths: [],
  warningThresholdReached: false,
  halted: false,
};

describe("CostSummaryCard", () => {
  beforeEach(() => {
    useQuery.mockReset();
  });

  it("renders loading state", () => {
    useQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    render(<CostSummaryCard orgId="org-1" />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders error state with the error message", () => {
    useQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("nope"),
    });
    render(<CostSummaryCard orgId="org-1" />);
    expect(
      screen.getByText(/Failed to load cost summary/i),
    ).toBeInTheDocument();
  });

  it("full variant renders amount, budget, remaining and projection", () => {
    useQuery.mockReturnValue({
      data: baseData,
      isLoading: false,
      error: null,
    });
    render(<CostSummaryCard orgId="org-1" variant="full" />);
    expect(screen.getByText(/\$12\.34/)).toBeInTheDocument();
    expect(screen.getByText(/\$50\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\$37\.66/)).toBeInTheDocument();
    expect(screen.getByText(/\$18\.50/)).toBeInTheDocument();
  });

  it("renders 'Unlimited' when budget is null", () => {
    useQuery.mockReturnValue({
      data: { ...baseData, budgetUsd: null, remainingUsd: null },
      isLoading: false,
      error: null,
    });
    render(<CostSummaryCard orgId="org-1" variant="full" />);
    expect(screen.getByText(/Unlimited/i)).toBeInTheDocument();
  });

  it("shows halted banner when halted=true", () => {
    useQuery.mockReturnValue({
      data: { ...baseData, halted: true },
      isLoading: false,
      error: null,
    });
    render(<CostSummaryCard orgId="org-1" variant="full" />);
    expect(screen.getByText(/halted until next month/i)).toBeInTheDocument();
  });

  it("shows warning banner at 80% threshold", () => {
    useQuery.mockReturnValue({
      data: {
        ...baseData,
        currentMonthSpendUsd: 40,
        remainingUsd: 10,
        warningThresholdReached: true,
      },
      isLoading: false,
      error: null,
    });
    render(<CostSummaryCard orgId="org-1" variant="full" />);
    expect(
      screen.getByText(/reached 80% of this month/i),
    ).toBeInTheDocument();
  });

  it("compact variant renders the small header label", () => {
    useQuery.mockReturnValue({
      data: baseData,
      isLoading: false,
      error: null,
    });
    render(<CostSummaryCard orgId="org-1" variant="compact" />);
    expect(
      screen.getByText(/This month's LLM spend/i),
    ).toBeInTheDocument();
  });
});

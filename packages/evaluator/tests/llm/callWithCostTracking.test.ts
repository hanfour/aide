import { describe, it, expect, vi, beforeEach } from "vitest";
import { callWithCostTracking } from "../../src/llm/callWithCostTracking";

describe("callWithCostTracking — happy path", () => {
  let mockLlmClient: { call: ReturnType<typeof vi.fn> };
  let mockEnforceBudget: ReturnType<typeof vi.fn>;
  let mockInsertLedger: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLlmClient = {
      call: vi.fn().mockResolvedValue({
        text: "response body",
        usage: { input_tokens: 500, output_tokens: 100 },
      }),
    };
    mockEnforceBudget = vi.fn().mockResolvedValue(undefined);
    mockInsertLedger = vi.fn().mockResolvedValue(undefined);
  });

  const baseCall = (overrides = {}) =>
    callWithCostTracking(
      {
        orgId: "org-1",
        eventType: "facet_extraction",
        model: "claude-haiku-4-5",
        refType: "request_body_facet",
        refId: "facet-1",
        prompt: { system: "s", user: "u", maxTokens: 256 },
        estimatedInputTokens: 500,
        ...overrides,
      },
      {
        llmClient: mockLlmClient,
        enforceBudget: mockEnforceBudget,
        insertLedger: mockInsertLedger,
      },
    );

  it("writes ledger row after successful call", async () => {
    const result = await baseCall();

    expect(mockEnforceBudget).toHaveBeenCalledTimes(1);
    expect(mockLlmClient.call).toHaveBeenCalledTimes(1);
    expect(mockInsertLedger).toHaveBeenCalledTimes(1);

    const ledgerRow = mockInsertLedger.mock.calls[0][0];
    expect(ledgerRow.orgId).toBe("org-1");
    expect(ledgerRow.eventType).toBe("facet_extraction");
    expect(ledgerRow.model).toBe("claude-haiku-4-5");
    expect(ledgerRow.tokensInput).toBe(500);
    expect(ledgerRow.tokensOutput).toBe(100);
    expect(ledgerRow.refType).toBe("request_body_facet");
    expect(ledgerRow.refId).toBe("facet-1");
    // haiku: 500 * 0.80/1M + 100 * 4/1M = 0.0004 + 0.0004 = 0.0008
    expect(ledgerRow.costUsd).toBeCloseTo(0.0008, 6);

    expect(result.response.text).toBe("response body");
    expect(result.cost).toBeCloseTo(0.0008, 6);
  });

  it("enforces budget BEFORE calling LLM", async () => {
    const order: string[] = [];
    mockEnforceBudget.mockImplementation(async () => {
      order.push("enforce");
    });
    mockLlmClient.call.mockImplementation(async () => {
      order.push("call");
      return { text: "", usage: { input_tokens: 0, output_tokens: 0 } };
    });
    mockInsertLedger.mockImplementation(async () => {
      order.push("ledger");
    });

    await baseCall();
    expect(order).toEqual(["enforce", "call", "ledger"]);
  });

  it("passes orgId and estimated cost to enforceBudget", async () => {
    await baseCall();
    expect(mockEnforceBudget).toHaveBeenCalledWith(
      "org-1",
      expect.any(Number),
    );
    const estimate = mockEnforceBudget.mock.calls[0][1];
    // estimated: 500 input + max 256 output on haiku
    // = (500 * 0.80 + 256 * 4) / 1M = (400 + 1024) / 1M = 0.001424
    expect(estimate).toBeCloseTo(0.001424, 6);
  });

  it("passes deep_analysis eventType through", async () => {
    await baseCall({ eventType: "deep_analysis", refType: "evaluation_report" });
    const row = mockInsertLedger.mock.calls[0][0];
    expect(row.eventType).toBe("deep_analysis");
    expect(row.refType).toBe("evaluation_report");
  });

  it("allows refType/refId to be omitted (deep_analysis without a specific ref)", async () => {
    await callWithCostTracking(
      {
        orgId: "org-1",
        eventType: "deep_analysis",
        model: "claude-haiku-4-5",
        prompt: { system: "", user: "", maxTokens: 10 },
        estimatedInputTokens: 100,
      },
      {
        llmClient: mockLlmClient,
        enforceBudget: mockEnforceBudget,
        insertLedger: mockInsertLedger,
      },
    );
    const row = mockInsertLedger.mock.calls[0][0];
    expect(row.refType).toBeUndefined();
    expect(row.refId).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import {
  anthropicStopReasonToChat,
  anthropicStopReasonToResponses,
  chatFinishReasonToAnthropic,
  chatFinishReasonToResponses,
  responsesFinishReasonToAnthropic,
  responsesFinishReasonToChat,
  type AnthropicStopReason,
  type ChatFinishReason,
  type ResponsesFinishReason,
} from "../src/translate/stopReasonMap.js";

describe("stopReasonMap — Anthropic ↔ Chat", () => {
  const cases: Array<[AnthropicStopReason, ChatFinishReason]> = [
    ["end_turn", "stop"],
    ["max_tokens", "length"],
    ["tool_use", "tool_calls"],
    ["stop_sequence", "stop"],
    ["refusal", "content_filter"],
  ];

  for (const [anthropic, chat] of cases) {
    it(`${anthropic} → ${chat}`, () => {
      expect(anthropicStopReasonToChat(anthropic)).toBe(chat);
    });
  }

  it("chat → anthropic (best-fit reverse)", () => {
    expect(chatFinishReasonToAnthropic("stop")).toBe("end_turn");
    expect(chatFinishReasonToAnthropic("length")).toBe("max_tokens");
    expect(chatFinishReasonToAnthropic("tool_calls")).toBe("tool_use");
    expect(chatFinishReasonToAnthropic("content_filter")).toBe("refusal");
  });
});

describe("stopReasonMap — Anthropic ↔ Responses", () => {
  const cases: Array<[AnthropicStopReason, ResponsesFinishReason]> = [
    ["end_turn", "stop"],
    ["max_tokens", "max_output_tokens"],
    ["tool_use", "tool_calls"],
    ["stop_sequence", "stop"],
    ["refusal", "content_filter"],
  ];

  for (const [anthropic, responses] of cases) {
    it(`${anthropic} → ${responses}`, () => {
      expect(anthropicStopReasonToResponses(anthropic)).toBe(responses);
    });
  }

  it("responses → anthropic (best-fit reverse)", () => {
    expect(responsesFinishReasonToAnthropic("stop")).toBe("end_turn");
    expect(responsesFinishReasonToAnthropic("max_output_tokens")).toBe(
      "max_tokens",
    );
    expect(responsesFinishReasonToAnthropic("tool_calls")).toBe("tool_use");
    expect(responsesFinishReasonToAnthropic("content_filter")).toBe("refusal");
  });
});

describe("stopReasonMap — pivots", () => {
  it("chat → responses pivots through anthropic correctly for each value", () => {
    expect(chatFinishReasonToResponses("stop")).toBe("stop");
    expect(chatFinishReasonToResponses("length")).toBe("max_output_tokens");
    expect(chatFinishReasonToResponses("tool_calls")).toBe("tool_calls");
    expect(chatFinishReasonToResponses("content_filter")).toBe(
      "content_filter",
    );
  });

  it("responses → chat pivots through anthropic correctly for each value", () => {
    expect(responsesFinishReasonToChat("stop")).toBe("stop");
    expect(responsesFinishReasonToChat("max_output_tokens")).toBe("length");
    expect(responsesFinishReasonToChat("tool_calls")).toBe("tool_calls");
    expect(responsesFinishReasonToChat("content_filter")).toBe(
      "content_filter",
    );
  });
});

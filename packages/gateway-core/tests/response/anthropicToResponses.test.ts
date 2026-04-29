import { describe, it, expect } from "vitest";
import { translateAnthropicResponseToResponses } from "../../src/translate/response/anthropicToResponses.js";
import type { AnthropicMessagesResponse } from "../../src/translate/types.js";

const NOW = () => 1700000000_000;

function makeAnthropic(
  overrides: Partial<AnthropicMessagesResponse> = {},
): AnthropicMessagesResponse {
  return {
    id: "msg_abc",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    model: "claude-3-5-sonnet-20241022",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

describe("translateAnthropicResponseToResponses", () => {
  it("plain text → single message output_item with output_text content", () => {
    const result = translateAnthropicResponseToResponses(makeAnthropic(), {
      now: NOW,
    });
    expect(result.id).toBe("msg_abc");
    expect(result.object).toBe("response");
    expect(result.created_at).toBe(1700000000);
    expect(result.status).toBe("completed");
    expect(result.output).toHaveLength(1);
    const msg = result.output[0]!;
    expect(msg.type).toBe("message");
    if (msg.type === "message") {
      expect(msg.role).toBe("assistant");
      expect(msg.status).toBe("completed");
      expect(msg.content).toEqual([
        { type: "output_text", text: "hi", annotations: [] },
      ]);
    }
  });

  it("multiple text blocks concatenate into a single message item", () => {
    const result = translateAnthropicResponseToResponses(
      makeAnthropic({
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
      }),
    );
    expect(result.output).toHaveLength(1);
    const msg = result.output[0]!;
    if (msg.type === "message") {
      expect(msg.content.map((c) => c.text)).toEqual(["hello ", "world"]);
    }
  });

  it("tool_use block becomes a function_call output_item", () => {
    const result = translateAnthropicResponseToResponses(
      makeAnthropic({
        content: [
          { type: "text", text: "calling tool" },
          {
            type: "tool_use",
            id: "tool_123",
            name: "get_weather",
            input: { city: "Taipei" },
          },
        ],
        stop_reason: "tool_use",
      }),
    );
    expect(result.output).toHaveLength(2);
    expect(result.output[0]!.type).toBe("message");
    const fc = result.output[1]!;
    expect(fc.type).toBe("function_call");
    if (fc.type === "function_call") {
      expect(fc.id).toBe("tool_123");
      expect(fc.call_id).toBe("tool_123");
      expect(fc.name).toBe("get_weather");
      expect(fc.arguments).toBe(JSON.stringify({ city: "Taipei" }));
    }
  });

  it("max_tokens stop_reason → status incomplete + reason max_output_tokens", () => {
    const result = translateAnthropicResponseToResponses(
      makeAnthropic({ stop_reason: "max_tokens" }),
    );
    expect(result.status).toBe("incomplete");
    expect(result.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("refusal stop_reason → status incomplete + reason content_filter", () => {
    const result = translateAnthropicResponseToResponses(
      makeAnthropic({ stop_reason: "refusal" }),
    );
    expect(result.status).toBe("incomplete");
    expect(result.incomplete_details).toEqual({ reason: "content_filter" });
  });

  it("null stop_reason → status in_progress", () => {
    const result = translateAnthropicResponseToResponses(
      makeAnthropic({ stop_reason: null }),
    );
    expect(result.status).toBe("in_progress");
    expect(result.incomplete_details).toBeNull();
  });

  it("usage cache_read maps to input_tokens_details.cached_tokens", () => {
    const result = translateAnthropicResponseToResponses(
      makeAnthropic({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 20,
        },
      }),
    );
    // Responses API surfaces the GROSS input total.
    expect(result.usage!.input_tokens).toBe(100 + 30 + 20);
    expect(result.usage!.output_tokens).toBe(50);
    expect(result.usage!.total_tokens).toBe(200);
    expect(result.usage!.input_tokens_details).toEqual({ cached_tokens: 20 });
  });

  it("zero cache_read does not emit input_tokens_details", () => {
    const result = translateAnthropicResponseToResponses(makeAnthropic());
    expect(result.usage!.input_tokens_details).toBeUndefined();
  });

  it("uses Date.now() when no `now` opt is provided", () => {
    const result = translateAnthropicResponseToResponses(makeAnthropic());
    expect(result.created_at).toBeGreaterThan(1700000000);
  });

  it("tool_use stop_reason → status='completed' (not incomplete)", () => {
    // Confirms only max_output_tokens / content_filter map to incomplete;
    // tool_use is a clean run-completion in the Responses model.
    const result = translateAnthropicResponseToResponses(
      makeAnthropic({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "f",
            input: {},
          },
        ],
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.incomplete_details).toBeNull();
  });
});

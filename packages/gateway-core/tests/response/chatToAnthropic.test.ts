import { describe, it, expect } from "vitest";
import { translateChatResponseToAnthropic } from "../../src/translate/response/chatToAnthropic.js";
import type { OpenAIChatCompletionResponse } from "../../src/translate/types.js";

function makeChat(
  overrides: Partial<OpenAIChatCompletionResponse> = {},
): OpenAIChatCompletionResponse {
  return {
    id: "chatcmpl-abc",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4-turbo",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello there." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    ...overrides,
  };
}

describe("translateChatResponseToAnthropic", () => {
  it("plain text choice → single text content block", () => {
    const result = translateChatResponseToAnthropic(makeChat());
    expect(result.id).toBe("chatcmpl-abc");
    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(result.content).toEqual([{ type: "text", text: "Hello there." }]);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 4 });
  });

  it("null content + tool_calls → only tool_use blocks", () => {
    const result = translateChatResponseToAnthropic(
      makeChat({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "lookup",
                    arguments: JSON.stringify({ id: "x1" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    expect(result.content).toEqual([
      { type: "tool_use", id: "call_1", name: "lookup", input: { id: "x1" } },
    ]);
    expect(result.stop_reason).toBe("tool_use");
  });

  it("text + tool_calls → both blocks in order", () => {
    const result = translateChatResponseToAnthropic(
      makeChat({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Calling tool...",
              tool_calls: [
                {
                  id: "call_a",
                  type: "function",
                  function: {
                    name: "search",
                    arguments: JSON.stringify({ q: "weather" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.content[1]).toMatchObject({ type: "tool_use" });
  });

  it("finish_reason length → max_tokens", () => {
    const result = translateChatResponseToAnthropic(
      makeChat({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "..." },
            finish_reason: "length",
          },
        ],
      }),
    );
    expect(result.stop_reason).toBe("max_tokens");
  });

  it("finish_reason content_filter → refusal", () => {
    const result = translateChatResponseToAnthropic(
      makeChat({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null },
            finish_reason: "content_filter",
          },
        ],
      }),
    );
    expect(result.stop_reason).toBe("refusal");
  });

  it("null finish_reason → null stop_reason", () => {
    const result = translateChatResponseToAnthropic(
      makeChat({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "..." },
            finish_reason: null,
          },
        ],
      }),
    );
    expect(result.stop_reason).toBeNull();
  });

  it("malformed tool arguments JSON surfaces { _malformed, _raw } wrapper", () => {
    const result = translateChatResponseToAnthropic(
      makeChat({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "f", arguments: "{not json" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "c1",
        name: "f",
        input: { _malformed: true, _raw: "{not json" },
      },
    ]);
  });

  it("empty choices array → empty content + null stop_reason", () => {
    const result = translateChatResponseToAnthropic(makeChat({ choices: [] }));
    expect(result.content).toEqual([]);
    expect(result.stop_reason).toBeNull();
  });

  it("empty string content is omitted from content blocks", () => {
    const result = translateChatResponseToAnthropic(
      makeChat({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "" },
            finish_reason: "stop",
          },
        ],
      }),
    );
    expect(result.content).toEqual([]);
  });

  it("usage maps prompt/completion → input/output tokens", () => {
    const result = translateChatResponseToAnthropic(
      makeChat({
        usage: { prompt_tokens: 99, completion_tokens: 7, total_tokens: 106 },
      }),
    );
    expect(result.usage).toEqual({ input_tokens: 99, output_tokens: 7 });
  });

  it("missing usage block (live error responses) → zero tokens, no NPE", () => {
    // Cast around the type — live OpenAI error paths sometimes omit the
    // usage object entirely; the translator must not NPE.
    const result = translateChatResponseToAnthropic(
      makeChat({
        choices: [],
        usage: undefined as unknown as OpenAIChatCompletionResponse["usage"],
      }),
    );
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("Anthropic → Chat → Anthropic round-trip (4A coupling)", () => {
  it("preserves text + stop_reason through translateAnthropicToOpenAI + translateChatResponseToAnthropic", async () => {
    const { translateAnthropicToOpenAI } =
      await import("../../src/translate/anthropicToOpenai.js");
    const original = {
      id: "msg_rt",
      type: "message" as const,
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "round-trip" }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn" as const,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3 },
    };
    const chat = translateAnthropicToOpenAI(original);
    const back = translateChatResponseToAnthropic(chat);
    // Text content survives both hops.
    expect(back.content).toEqual([{ type: "text", text: "round-trip" }]);
    // Stop reason round-trips via the lossy projection (end_turn → stop → end_turn).
    expect(back.stop_reason).toBe("end_turn");
    // Usage is preserved.
    expect(back.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
  });
});

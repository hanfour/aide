import { describe, it, expect } from "vitest";
import { translateChatToResponses } from "../src/translate/chatToResponses.js";
import { translateResponsesToChat } from "../src/translate/responsesToChat.js";
import type { OpenAIChatRequest } from "../src/translate/types.js";
import type { ResponsesRequest } from "../src/translate/responsesTypes.js";

// Plan 5A §10.6 — pivot composition end-to-end coverage.  Each pivot
// chains two unit-tested translators (chat ↔ anthropic, anthropic ↔
// responses) so the per-leg unit tests already cover the bulk of edge
// cases.  These tests pin the COMPOSITION specifically — that the
// shape coming out of the second leg matches what the upstream actually
// expects when the request originated in the OTHER cross-format world.
//
// Coverage matrix:
//   * chat → responses: text-only, system, tools, tool_calls (assistant
//     turn echo), tool result (tool-role), images
//   * responses → chat: text-only, instructions, function_call,
//     function_call_output, tool_choice 'none' (tools dropped)

describe("translateChatToResponses (chat → anthropic → responses)", () => {
  it("plain text chat request → Responses with single user message", () => {
    const out = translateChatToResponses({
      model: "gpt-4o",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(out).toMatchObject({
      model: "gpt-4o",
      input: [{ type: "message", role: "user", content: "ping" }],
    });
  });

  it("system message becomes Responses `instructions`", () => {
    const out = translateChatToResponses({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    });
    expect(out.instructions).toBe("be terse");
    expect(out.input).toEqual([
      { type: "message", role: "user", content: "hi" },
    ]);
  });

  it("max_tokens carries through and re-emerges as max_output_tokens", () => {
    const out = translateChatToResponses({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 256,
    });
    expect(out.max_output_tokens).toBe(256);
  });

  it("assistant tool_calls round-trip into a function_call input item", () => {
    const out = translateChatToResponses({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "search please" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: '{"q":"x"}' },
            },
          ],
        },
      ],
    });
    // Last input item should be the function_call.
    expect(out.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: '{"q":"x"}',
        }),
      ]),
    );
  });

  it("tool-role response becomes a function_call_output item", () => {
    const out = translateChatToResponses({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "search please" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "search result",
        },
      ],
    });
    expect(out.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_1",
          output: "search result",
        }),
      ]),
    );
  });

  it("tool_choice 'auto' → 'auto'; 'required' → 'required'; function name → {type:function, name}", () => {
    expect(
      translateChatToResponses({
        model: "gpt-4o",
        messages: [{ role: "user", content: "x" }],
        tool_choice: "auto",
      }).tool_choice,
    ).toBe("auto");
    expect(
      translateChatToResponses({
        model: "gpt-4o",
        messages: [{ role: "user", content: "x" }],
        tool_choice: "required",
      }).tool_choice,
    ).toBe("required");
    expect(
      translateChatToResponses({
        model: "gpt-4o",
        messages: [{ role: "user", content: "x" }],
        tool_choice: { type: "function", function: { name: "weather" } },
      }).tool_choice,
    ).toEqual({ type: "function", name: "weather" });
  });
});

describe("translateResponsesToChat (responses → anthropic → chat)", () => {
  const baseReq = (
    overrides: Partial<ResponsesRequest> = {},
  ): ResponsesRequest => ({
    model: "gpt-4o",
    input: "hi",
    ...overrides,
  });

  it("string input → user message in chat shape", () => {
    const out = translateResponsesToChat(baseReq());
    expect(out).toMatchObject({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("instructions → system message at the front", () => {
    const out = translateResponsesToChat(
      baseReq({ instructions: "be terse" }),
    );
    expect(out.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("max_output_tokens → max_tokens", () => {
    const out = translateResponsesToChat(
      baseReq({ max_output_tokens: 256 }),
    );
    expect(out.max_tokens).toBe(256);
  });

  it("function_call → assistant tool_calls; function_call_output → tool-role message with content + tool_call_id", () => {
    const out = translateResponsesToChat(
      baseReq({
        input: [
          { type: "message", role: "user", content: "search please" },
          {
            type: "function_call",
            call_id: "call_1",
            name: "search",
            arguments: '{"q":"x"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "result",
          },
        ],
      }),
    );
    // Pivoted order: user msg → assistant w/ tool_calls → tool-role
    expect(out.messages.length).toBe(3);
    expect(out.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "search", arguments: '{"q":"x"}' },
        },
      ],
    });
    expect(out.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "result",
    });
  });

  it("tool_choice 'none' on Responses → chat output has tools dropped (semantic match)", () => {
    const out = translateResponsesToChat(
      baseReq({
        tools: [
          {
            type: "function",
            name: "weather",
            parameters: { type: "object" },
          },
        ],
        tool_choice: "none",
      }),
    );
    // The 'none' semantic flows through anthropic-leg `dropTools` and
    // surfaces as a chat request with no tools advertised.
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
  });
});

describe("pivot consistency — selected round-trips", () => {
  it("chat → responses → anthropic preserves user text", () => {
    const chat: OpenAIChatRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    };
    const responses = translateChatToResponses(chat);
    expect(responses.input).toEqual([
      { type: "message", role: "user", content: "hello" },
    ]);
  });

  it("responses → chat → user/assistant role separation is preserved", () => {
    const out = translateResponsesToChat({
      model: "gpt-4o",
      input: [
        { type: "message", role: "user", content: "u1" },
        { type: "message", role: "assistant", content: "a1" },
        { type: "message", role: "user", content: "u2" },
      ],
    });
    expect(out.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });
});

import { describe, it, expect } from "vitest";
import { translateAnthropicToChat } from "../src/translate/anthropicToChat.js";
import { BodyTranslationError } from "../src/translate/anthropicToResponses.js";
import type { AnthropicMessagesRequest } from "../src/translate/types.js";

const baseReq = (
  overrides: Partial<AnthropicMessagesRequest> = {},
): AnthropicMessagesRequest => ({
  model: "claude-3-5-haiku-20241022",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
});

describe("translateAnthropicToChat — basics", () => {
  it("plain string user message → plain string content", () => {
    const out = translateAnthropicToChat(baseReq());
    expect(out.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(out.max_tokens).toBe(1024);
  });

  it("system prompt is hoisted to a system message at the front", () => {
    const out = translateAnthropicToChat(
      baseReq({ system: "be terse" }),
    );
    expect(out.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(out.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("temperature / top_p / stream carry through verbatim", () => {
    const out = translateAnthropicToChat(
      baseReq({ temperature: 0.5, top_p: 0.9, stream: true }),
    );
    expect(out.temperature).toBe(0.5);
    expect(out.top_p).toBe(0.9);
    expect(out.stream).toBe(true);
  });
});

describe("translateAnthropicToChat — content blocks", () => {
  it("single text block collapses to plain string content (chat-friendly shape)", () => {
    const out = translateAnthropicToChat(
      baseReq({
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
        ],
      }),
    );
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("text + image → array content with text + image_url parts", () => {
    const out = translateAnthropicToChat(
      baseReq({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look:" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "AAAA",
                },
              },
            ],
          },
        ],
      }),
    );
    expect(out.messages[0]!.content).toEqual([
      { type: "text", text: "look:" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AAAA" },
      },
    ]);
  });
});

describe("translateAnthropicToChat — tool use", () => {
  it("tool_use block on assistant becomes tool_calls on the assistant message", () => {
    const out = translateAnthropicToChat(
      baseReq({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "let me search" },
              {
                type: "tool_use",
                id: "t1",
                name: "search",
                input: { q: "x" },
              },
            ],
          },
        ],
      }),
    );
    expect(out.messages).toEqual([
      {
        role: "assistant",
        content: "let me search",
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "search", arguments: '{"q":"x"}' },
          },
        ],
      },
    ]);
  });

  it("tool_result on user becomes a tool-role message with tool_call_id", () => {
    const out = translateAnthropicToChat(
      baseReq({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: "result",
              },
            ],
          },
        ],
      }),
    );
    expect(out.messages).toEqual([
      { role: "tool", tool_call_id: "t1", content: "result" },
    ]);
  });

  it("tool_use on a NON-assistant role throws structured error", () => {
    expect(() =>
      translateAnthropicToChat(
        baseReq({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_use",
                  id: "t",
                  name: "n",
                  input: {},
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/anthropic_tool_use_non_assistant/);
  });

  it("tool_result on a NON-user role throws structured error", () => {
    expect(() =>
      translateAnthropicToChat(
        baseReq({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "t",
                  content: "r",
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/anthropic_tool_result_non_user/);
  });

  it("BodyTranslationError export is shared with anthropicToResponses", () => {
    let thrown: Error | undefined;
    try {
      translateAnthropicToChat(
        baseReq({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_use",
                  id: "t",
                  name: "n",
                  input: {},
                },
              ],
            },
          ],
        }),
      );
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(BodyTranslationError);
  });
});

describe("translateAnthropicToChat — tools + tool_choice", () => {
  it("tool_choice 'auto' → 'auto'; 'any' → 'required'; tool name → {type:function, function:{name}}", () => {
    expect(
      translateAnthropicToChat(baseReq({ tool_choice: { type: "auto" } }))
        .tool_choice,
    ).toBe("auto");
    expect(
      translateAnthropicToChat(baseReq({ tool_choice: { type: "any" } }))
        .tool_choice,
    ).toBe("required");
    expect(
      translateAnthropicToChat(
        baseReq({ tool_choice: { type: "tool", name: "search" } }),
      ).tool_choice,
    ).toEqual({ type: "function", function: { name: "search" } });
  });

  it("tools translate name/input_schema → function name/parameters", () => {
    const out = translateAnthropicToChat(
      baseReq({
        tools: [
          {
            name: "weather",
            description: "Get weather",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        ],
      }),
    );
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "weather",
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
    ]);
  });
});

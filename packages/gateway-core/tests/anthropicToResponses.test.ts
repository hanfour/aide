import { describe, it, expect } from "vitest";
import {
  translateAnthropicToResponses,
  BodyTranslationError,
} from "../src/translate/anthropicToResponses.js";
import type { AnthropicMessagesRequest } from "../src/translate/types.js";

const baseReq = (
  overrides: Partial<AnthropicMessagesRequest> = {},
): AnthropicMessagesRequest => ({
  model: "claude-3-5-haiku-20241022",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
});

describe("translateAnthropicToResponses — basics", () => {
  it("plain string user message becomes a single Responses message item", () => {
    const out = translateAnthropicToResponses(baseReq());
    expect(out.model).toBe("claude-3-5-haiku-20241022");
    expect(out.max_output_tokens).toBe(1024);
    expect(out.input).toEqual([
      { type: "message", role: "user", content: "hello" },
    ]);
  });

  it("system prompt becomes instructions; max_tokens becomes max_output_tokens", () => {
    const out = translateAnthropicToResponses(
      baseReq({ system: "be terse", max_tokens: 256, temperature: 0.5 }),
    );
    expect(out.instructions).toBe("be terse");
    expect(out.max_output_tokens).toBe(256);
    expect(out.temperature).toBe(0.5);
  });

  it("stream + top_p carry through verbatim", () => {
    const out = translateAnthropicToResponses(
      baseReq({ stream: true, top_p: 0.9 }),
    );
    expect(out.stream).toBe(true);
    expect(out.top_p).toBe(0.9);
  });
});

describe("translateAnthropicToResponses — content blocks", () => {
  it("text blocks become input_text on user role and output_text on assistant role", () => {
    const out = translateAnthropicToResponses(
      baseReq({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi" }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "hello back" }],
          },
        ],
      }),
    );
    expect(out.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello back" }],
      },
    ]);
  });

  it("base64 image becomes input_image with a data URI", () => {
    const out = translateAnthropicToResponses(
      baseReq({
        messages: [
          {
            role: "user",
            content: [
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
    expect(out.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ]);
  });

  it("URL image source passes through", () => {
    const out = translateAnthropicToResponses(
      baseReq({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "url", url: "https://example.com/x.png" },
              },
            ],
          },
        ],
      }),
    );
    expect(out.input[1] ?? out.input[0]).toMatchObject({
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "https://example.com/x.png" },
      ],
    });
  });
});

describe("translateAnthropicToResponses — tool use", () => {
  it("tool_use block on assistant becomes a function_call input item", () => {
    const out = translateAnthropicToResponses(
      baseReq({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool_1",
                name: "search",
                input: { query: "hello" },
              },
            ],
          },
        ],
      }),
    );
    expect(out.input).toEqual([
      {
        type: "function_call",
        call_id: "tool_1",
        name: "search",
        arguments: '{"query":"hello"}',
      },
    ]);
  });

  it("tool_result block on user becomes a function_call_output item with concatenated text content", () => {
    const out = translateAnthropicToResponses(
      baseReq({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_1",
                content: [
                  { type: "text", text: "result A" },
                  { type: "text", text: " then B" },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(out.input).toEqual([
      {
        type: "function_call_output",
        call_id: "tool_1",
        output: "result A then B",
      },
    ]);
  });

  it("mixed text + tool_use within one assistant message preserves order across multiple emitted items", () => {
    const out = translateAnthropicToResponses(
      baseReq({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "thinking..." },
              {
                type: "tool_use",
                id: "t1",
                name: "search",
                input: {},
              },
              { type: "text", text: "...done" },
            ],
          },
        ],
      }),
    );
    expect(out.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "thinking..." }],
      },
      {
        type: "function_call",
        call_id: "t1",
        name: "search",
        arguments: "{}",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "...done" }],
      },
    ]);
  });
});

describe("translateAnthropicToResponses — tools + tool_choice", () => {
  it("tools translate name/input_schema → function name/parameters", () => {
    const out = translateAnthropicToResponses(
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
        name: "weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ]);
  });

  it("tool_choice 'auto' → 'auto'; 'any' → 'required'; tool name → function:name", () => {
    expect(
      translateAnthropicToResponses(baseReq({ tool_choice: { type: "auto" } }))
        .tool_choice,
    ).toBe("auto");
    expect(
      translateAnthropicToResponses(baseReq({ tool_choice: { type: "any" } }))
        .tool_choice,
    ).toBe("required");
    expect(
      translateAnthropicToResponses(
        baseReq({ tool_choice: { type: "tool", name: "weather" } }),
      ).tool_choice,
    ).toEqual({ type: "function", name: "weather" });
  });
});

describe("BodyTranslationError export", () => {
  it("is constructible with code + detail; message prefixes code so `.toThrow(/code/)` works", () => {
    const err = new BodyTranslationError("test_code", "detail msg");
    expect(err.code).toBe("test_code");
    expect(err.message).toBe("test_code: detail msg");
    expect(err.name).toBe("BodyTranslationError");
  });
});

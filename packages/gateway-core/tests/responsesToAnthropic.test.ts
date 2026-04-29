import { describe, it, expect } from "vitest";
import { translateResponsesToAnthropic } from "../src/translate/responsesToAnthropic.js";
import { BodyTranslationError } from "../src/translate/anthropicToResponses.js";
import type { ResponsesRequest } from "../src/translate/responsesTypes.js";

const baseReq = (
  overrides: Partial<ResponsesRequest> = {},
): ResponsesRequest => ({
  model: "gpt-4o",
  input: "hello",
  ...overrides,
});

describe("translateResponsesToAnthropic — basics", () => {
  it("string input becomes a single user message with default max_tokens", () => {
    const out = translateResponsesToAnthropic(baseReq());
    expect(out.model).toBe("gpt-4o");
    expect(out.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(out.max_tokens).toBe(4096); // documented default
  });

  it("instructions becomes system prompt; max_output_tokens becomes max_tokens", () => {
    const out = translateResponsesToAnthropic(
      baseReq({
        instructions: "be terse",
        max_output_tokens: 256,
        temperature: 0.5,
      }),
    );
    expect(out.system).toBe("be terse");
    expect(out.max_tokens).toBe(256);
    expect(out.temperature).toBe(0.5);
  });

  it("stream + top_p carry through verbatim", () => {
    const out = translateResponsesToAnthropic(
      baseReq({ stream: true, top_p: 0.9 }),
    );
    expect(out.stream).toBe(true);
    expect(out.top_p).toBe(0.9);
  });
});

describe("translateResponsesToAnthropic — input items", () => {
  it("consecutive same-role messages collapse into one anthropic message with multiple text blocks", () => {
    const out = translateResponsesToAnthropic(
      baseReq({
        input: [
          { type: "message", role: "user", content: "first" },
          { type: "message", role: "user", content: "second" },
        ],
      }),
    );
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  it("alternating roles produce separate anthropic messages", () => {
    const out = translateResponsesToAnthropic(
      baseReq({
        input: [
          { type: "message", role: "user", content: "u1" },
          { type: "message", role: "assistant", content: "a1" },
          { type: "message", role: "user", content: "u2" },
        ],
      }),
    );
    expect(out.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  it("input_image with data URI becomes base64 image source", () => {
    const out = translateResponsesToAnthropic(
      baseReq({
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: "data:image/png;base64,AAAA",
              },
            ],
          },
        ],
      }),
    );
    const blocks = out.messages[0]!.content as unknown as Array<{
      type: string;
      [k: string]: unknown;
    }>;
    expect(blocks[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });

  it("input_image with HTTP URL becomes URL image source", () => {
    const out = translateResponsesToAnthropic(
      baseReq({
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: "https://example.com/x.png",
              },
            ],
          },
        ],
      }),
    );
    const blocks = out.messages[0]!.content as unknown as Array<{
      type: string;
      [k: string]: unknown;
    }>;
    expect(blocks[0]).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/x.png" },
    });
  });
});

describe("translateResponsesToAnthropic — function calls + outputs", () => {
  it("function_call → tool_use block on a new assistant message", () => {
    const out = translateResponsesToAnthropic(
      baseReq({
        input: [
          { type: "message", role: "user", content: "do search" },
          {
            type: "function_call",
            call_id: "t1",
            name: "search",
            arguments: '{"q":"hello"}',
          },
        ],
      }),
    );
    expect(out.messages.length).toBe(2);
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "search",
          input: { q: "hello" },
        },
      ],
    });
  });

  it("function_call_output → tool_result block on user message", () => {
    const out = translateResponsesToAnthropic(
      baseReq({
        input: [
          {
            type: "function_call",
            call_id: "t1",
            name: "search",
            arguments: '{"q":"x"}',
          },
          { type: "function_call_output", call_id: "t1", output: "result" },
        ],
      }),
    );
    expect(out.messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "search",
            input: { q: "x" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "result" },
        ],
      },
    ]);
  });

  it("function_call.arguments empty string parses to {}", () => {
    const out = translateResponsesToAnthropic(
      baseReq({
        input: [
          {
            type: "function_call",
            call_id: "t",
            name: "n",
            arguments: "",
          },
        ],
      }),
    );
    const block = (out.messages[0]!.content as Array<{ input: unknown }>)[0]!;
    expect(block.input).toEqual({});
  });

  it("function_call.arguments invalid JSON throws BodyTranslationError", () => {
    expect(() =>
      translateResponsesToAnthropic(
        baseReq({
          input: [
            {
              type: "function_call",
              call_id: "t",
              name: "n",
              arguments: "{not json",
            },
          ],
        }),
      ),
    ).toThrow(BodyTranslationError);
  });

  it("function_call.arguments JSON-decodes to non-object → throws", () => {
    expect(() =>
      translateResponsesToAnthropic(
        baseReq({
          input: [
            {
              type: "function_call",
              call_id: "t",
              name: "n",
              arguments: '"a string"',
            },
          ],
        }),
      ),
    ).toThrow(/responses_function_call_arguments_not_object/);
  });
});

describe("translateResponsesToAnthropic — tools + tool_choice", () => {
  it("tools translate function/parameters → name/input_schema", () => {
    const out = translateResponsesToAnthropic(
      baseReq({
        tools: [
          {
            type: "function",
            name: "weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        ],
      }),
    );
    expect(out.tools).toEqual([
      {
        name: "weather",
        description: "Get weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ]);
  });

  it("tool_choice 'auto' → {type:auto}; 'required' → {type:any}; function:name → {type:tool, name}", () => {
    expect(
      translateResponsesToAnthropic(baseReq({ tool_choice: "auto" }))
        .tool_choice,
    ).toEqual({ type: "auto" });
    expect(
      translateResponsesToAnthropic(baseReq({ tool_choice: "required" }))
        .tool_choice,
    ).toEqual({ type: "any" });
    expect(
      translateResponsesToAnthropic(
        baseReq({ tool_choice: { type: "function", name: "weather" } }),
      ).tool_choice,
    ).toEqual({ type: "tool", name: "weather" });
  });

  it("tool_choice 'none' DROPS the `tools` field entirely (Anthropic has no 'none'; honour OpenAI semantics by removing the tools advertisement)", () => {
    const out = translateResponsesToAnthropic(
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
    // `tools` is removed AND tool_choice is not set.  The model receives
    // a request with no tool capability — the only honest mapping of
    // OpenAI's "none" semantics into Anthropic's API.
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
  });
});

describe("translateResponsesToAnthropic — rejected features", () => {
  it("system-role input message is rejected with a structured error", () => {
    expect(() =>
      translateResponsesToAnthropic(
        baseReq({
          input: [{ type: "message", role: "system", content: "system text" }],
        }),
      ),
    ).toThrow(/responses_input_system_role_unsupported/);
  });

  it("invalid base64 data URI throws BodyTranslationError", () => {
    expect(() =>
      translateResponsesToAnthropic(
        baseReq({
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_image", image_url: "data:bogus" }],
            },
          ],
        }),
      ),
    ).toThrow(/responses_image_url_invalid_data_uri/);
  });
});

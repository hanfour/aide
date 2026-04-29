import { describe, it, expect } from "vitest";
import { translateResponsesResponseToAnthropic } from "../../src/translate/response/responsesToAnthropic.js";
import type { ResponsesResponse } from "../../src/translate/responsesTypes.js";

function makeResp(
  overrides: Partial<ResponsesResponse> = {},
): ResponsesResponse {
  return {
    id: "resp_abc",
    object: "response",
    created_at: 1700000000,
    model: "gpt-4o",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    incomplete_details: null,
    ...overrides,
  };
}

describe("translateResponsesResponseToAnthropic", () => {
  it("message output_item → text content block", () => {
    const result = translateResponsesResponseToAnthropic(makeResp());
    expect(result.id).toBe("resp_abc");
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.stop_reason).toBe("end_turn");
  });

  it("multiple output_text parts in one message concatenate", () => {
    const result = translateResponsesResponseToAnthropic(
      makeResp({
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "foo " },
              { type: "output_text", text: "bar" },
            ],
          },
        ],
      }),
    );
    expect(result.content).toEqual([{ type: "text", text: "foo bar" }]);
  });

  it("function_call output_item → tool_use block + tool_use stop_reason", () => {
    const result = translateResponsesResponseToAnthropic(
      makeResp({
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "fc_1",
            name: "get_weather",
            arguments: JSON.stringify({ city: "Tokyo" }),
            status: "completed",
          },
        ],
      }),
    );
    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "fc_1",
        name: "get_weather",
        input: { city: "Tokyo" },
      },
    ]);
    expect(result.stop_reason).toBe("tool_use");
  });

  it("status=incomplete + reason=max_output_tokens → max_tokens", () => {
    const result = translateResponsesResponseToAnthropic(
      makeResp({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    );
    expect(result.stop_reason).toBe("max_tokens");
  });

  it("status=incomplete + reason=content_filter → refusal", () => {
    const result = translateResponsesResponseToAnthropic(
      makeResp({
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
      }),
    );
    expect(result.stop_reason).toBe("refusal");
  });

  it("status=in_progress → null stop_reason", () => {
    const result = translateResponsesResponseToAnthropic(
      makeResp({ status: "in_progress" }),
    );
    expect(result.stop_reason).toBeNull();
  });

  it("usage.cached_tokens maps to cache_read_input_tokens; non-cached subtracted", () => {
    const result = translateResponsesResponseToAnthropic(
      makeResp({
        usage: {
          input_tokens: 100,
          output_tokens: 30,
          total_tokens: 130,
          input_tokens_details: { cached_tokens: 25 },
        },
      }),
    );
    // 100 gross - 25 cached = 75 non-cached
    expect(result.usage.input_tokens).toBe(75);
    expect(result.usage.cache_read_input_tokens).toBe(25);
    expect(result.usage.output_tokens).toBe(30);
  });

  it("missing usage block → zeros", () => {
    const result = translateResponsesResponseToAnthropic(
      makeResp({ usage: undefined }),
    );
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("malformed function_call arguments surface { _malformed, _raw } wrapper", () => {
    const result = translateResponsesResponseToAnthropic(
      makeResp({
        output: [
          {
            type: "function_call",
            id: "fc_2",
            call_id: "fc_2",
            name: "f",
            arguments: "not json",
            status: "completed",
          },
        ],
      }),
    );
    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "fc_2",
        name: "f",
        input: { _malformed: true, _raw: "not json" },
      },
    ]);
  });

  it("function_call before message text still surfaces tool_use stop_reason", () => {
    const result = translateResponsesResponseToAnthropic(
      makeResp({
        output: [
          {
            type: "message",
            id: "msg_x",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "calling" }],
          },
          {
            type: "function_call",
            id: "fc_x",
            call_id: "fc_x",
            name: "f",
            arguments: "{}",
            status: "completed",
          },
        ],
      }),
    );
    expect(result.stop_reason).toBe("tool_use");
    expect(result.content).toEqual([
      { type: "text", text: "calling" },
      { type: "tool_use", id: "fc_x", name: "f", input: {} },
    ]);
  });

  it("output_text annotations are dropped (no Anthropic equivalent)", () => {
    // Annotations carry citations/file IDs etc. that have no Anthropic
    // analogue.  We deliberately drop them rather than smuggle them in
    // a non-standard field — the test documents this contract.
    const result = translateResponsesResponseToAnthropic(
      makeResp({
        output: [
          {
            type: "message",
            id: "m_anno",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "see citation",
                annotations: [
                  { type: "url_citation", url: "https://example.com" },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(result.content).toEqual([{ type: "text", text: "see citation" }]);
  });
});

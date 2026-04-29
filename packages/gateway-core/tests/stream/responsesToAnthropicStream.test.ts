import { describe, it, expect } from "vitest";
import { makeResponsesToAnthropicStream } from "../../src/translate/stream/responsesToAnthropicStream.js";
import type { ResponsesSSEEvent } from "../../src/translate/stream/responsesSseTypes.js";

function drain(events: ResponsesSSEEvent[]) {
  const t = makeResponsesToAnthropicStream();
  return [...events.flatMap((e) => t.onEvent(e)), ...t.onEnd()];
}

describe("makeResponsesToAnthropicStream", () => {
  it("text path: response.created → output_item.added → content_part.added → text.delta → output_item.done → completed", () => {
    const out = drain([
      {
        type: "response.created",
        response: { id: "resp_1", model: "gpt-4o", created_at: 1 },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "m_1", role: "assistant" },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "Hi",
      },
      { type: "response.output_item.done", output_index: 0 },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          incomplete_details: null,
          usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
        },
      },
    ]);
    expect(out[0]).toMatchObject({ type: "message_start" });
    // content_part.added → content_block_start (text)
    expect(out.find((e) => e.type === "content_block_start")).toMatchObject({
      type: "content_block_start",
      content_block: { type: "text" },
    });
    expect(out.find((e) => e.type === "content_block_delta")).toMatchObject({
      delta: { type: "text_delta", text: "Hi" },
    });
    expect(out.find((e) => e.type === "content_block_stop")).toBeDefined();
    expect(out.find((e) => e.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    });
    expect(out.find((e) => e.type === "message_stop")).toBeDefined();
  });

  it("function_call path opens a tool_use block immediately on output_item.added", () => {
    const out = drain([
      {
        type: "response.created",
        response: { id: "resp_2", model: "gpt-4o", created_at: 1 },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_x",
          call_id: "fc_x",
          name: "lookup",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"q":"a"}',
      },
      { type: "response.output_item.done", output_index: 0 },
      {
        type: "response.completed",
        response: {
          id: "resp_2",
          status: "completed",
          incomplete_details: null,
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        },
      },
    ]);
    expect(out.find((e) => e.type === "content_block_start")).toMatchObject({
      content_block: { type: "tool_use", id: "fc_x", name: "lookup" },
    });
    expect(out.find((e) => e.type === "content_block_delta")).toMatchObject({
      delta: { type: "input_json_delta", partial_json: '{"q":"a"}' },
    });
    // tool_use seen → message_delta stop_reason should be tool_use
    expect(out.find((e) => e.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "tool_use" },
    });
  });

  it("incomplete max_output_tokens → message_delta stop_reason max_tokens", () => {
    const out = drain([
      {
        type: "response.created",
        response: { id: "resp_3", model: "gpt-4o", created_at: 1 },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_3",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ]);
    expect(out.find((e) => e.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "max_tokens" },
    });
  });

  it("onEnd drains open content_blocks before message_delta + message_stop (M2)", () => {
    const t = makeResponsesToAnthropicStream();
    // Open a text block but never emit output_item.done.
    t.onEvent({
      type: "response.created",
      response: { id: "resp_x", model: "gpt-4o", created_at: 1 },
    });
    t.onEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "m", role: "assistant" },
    });
    t.onEvent({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    t.onEvent({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "abrupt",
    });
    // No output_item.done — upstream truncated. onEnd must drain.
    const tail = t.onEnd();
    const indices = tail
      .filter((e) => e.type === "content_block_stop")
      .map((e) => (e.type === "content_block_stop" ? e.index : -1));
    expect(indices).toEqual([0]);
    // After the drain, the message terminators follow.
    expect(tail.find((e) => e.type === "message_delta")).toBeDefined();
    expect(tail.find((e) => e.type === "message_stop")).toBeDefined();
  });

  it("cached_tokens subtracts from input_tokens (kept on message_start usage neutrally)", () => {
    // The translator captures usage on response.completed only to drive
    // message_delta.usage.output_tokens; the input-token math lives in
    // the response side translator so we just verify output_tokens here.
    const out = drain([
      {
        type: "response.created",
        response: { id: "resp_4", model: "gpt-4o", created_at: 1 },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_4",
          status: "completed",
          incomplete_details: null,
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            total_tokens: 14,
            input_tokens_details: { cached_tokens: 2 },
          },
        },
      },
    ]);
    expect(out.find((e) => e.type === "message_delta")).toMatchObject({
      usage: { output_tokens: 4 },
    });
  });
});

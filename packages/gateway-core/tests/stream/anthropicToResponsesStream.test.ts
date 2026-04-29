import { describe, it, expect } from "vitest";
import { makeAnthropicToResponsesStream } from "../../src/translate/stream/anthropicToResponsesStream.js";
import type { AnthropicSSEEvent } from "../../src/stream/anthropicSseParser.js";

const NOW = () => 1700000000;

function drain(events: AnthropicSSEEvent[]) {
  const t = makeAnthropicToResponsesStream({ now: NOW });
  return [...events.flatMap((e) => t.onEvent(e)), ...t.onEnd()];
}

const start = (extra: Partial<AnthropicSSEEvent> = {}): AnthropicSSEEvent =>
  ({
    type: "message_start",
    message: {
      id: "msg_x",
      model: "claude-3-5",
      role: "assistant",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
    ...extra,
  }) as AnthropicSSEEvent;

describe("makeAnthropicToResponsesStream", () => {
  it("text-only stream emits response.created → message item → output_text deltas → done → completed", () => {
    const out = drain([
      start(),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]);
    expect(out[0]).toMatchObject({ type: "response.created" });
    expect(out[1]).toMatchObject({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message" },
    });
    expect(out[2]).toMatchObject({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
    });
    expect(out[3]).toMatchObject({
      type: "response.output_text.delta",
      delta: "Hi",
    });
    expect(out[4]).toMatchObject({
      type: "response.output_item.done",
      output_index: 0,
    });
    expect(out[5]).toMatchObject({
      type: "response.completed",
      response: { status: "completed" },
    });
  });

  it("tool_use block emits function_call output_item + arg deltas", () => {
    const out = drain([
      start(),
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tu_a",
          name: "lookup",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"q":1}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ]);
    expect(out[1]).toMatchObject({
      type: "response.output_item.added",
      item: { type: "function_call", id: "tu_a", name: "lookup" },
    });
    expect(out[2]).toMatchObject({
      type: "response.function_call_arguments.delta",
      delta: '{"q":1}',
    });
  });

  it("max_tokens stop_reason → status incomplete + reason max_output_tokens", () => {
    const out = drain([
      start(),
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    ]);
    expect(out.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    });
  });

  it("usage cache_read surfaces in input_tokens_details.cached_tokens", () => {
    const out = drain([
      {
        type: "message_start",
        message: {
          id: "msg_y",
          model: "claude-3-5",
          role: "assistant",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 3,
          },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ]);
    expect(out.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 18, // 10 + 5 + 3
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 3 },
        },
      },
    });
  });

  it("onEnd without message_stop emits a tail completed event", () => {
    const t = makeAnthropicToResponsesStream({ now: NOW });
    t.onEvent(start());
    const tail = t.onEnd();
    expect(tail.at(-1)).toMatchObject({ type: "response.completed" });
  });
});

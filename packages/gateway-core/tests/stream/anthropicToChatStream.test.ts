import { describe, it, expect } from "vitest";
import { makeAnthropicToChatStream } from "../../src/translate/stream/anthropicToChatStream.js";
import type { AnthropicSSEEvent } from "../../src/stream/anthropicSseParser.js";

const NOW = () => 1700000000;

function drain(events: AnthropicSSEEvent[]) {
  const t = makeAnthropicToChatStream({ now: NOW });
  const out: ReturnType<typeof t.onEvent> = [];
  for (const e of events) out.push(...t.onEvent(e));
  out.push(...t.onEnd());
  return out;
}

describe("makeAnthropicToChatStream", () => {
  it("text-only stream emits role chunk, deltas, terminator, [DONE]", () => {
    const out = drain([
      {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-3-5",
          role: "assistant",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi " },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "there" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ]);
    // First chunk: role only
    expect(out[0]).toMatchObject({
      choices: [{ delta: { role: "assistant", content: "" } }],
    });
    // Two text deltas
    expect(out[1]).toMatchObject({ choices: [{ delta: { content: "Hi " } }] });
    expect(out[2]).toMatchObject({ choices: [{ delta: { content: "there" } }] });
    // Terminal chunk with finish_reason + usage
    expect(out[3]).toMatchObject({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    expect(out[4]).toBe("[DONE]");
  });

  it("tool_use block emits role + initial tool_calls + arg deltas + terminator", () => {
    const out = drain([
      {
        type: "message_start",
        message: {
          id: "msg_2",
          model: "claude-3-5",
          role: "assistant",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tu_1",
          name: "lookup",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ]);
    expect(out[1]).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "tu_1",
                type: "function",
                function: { name: "lookup", arguments: "" },
              },
            ],
          },
        },
      ],
    });
    expect(out[2]).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '{"q":"x"}' } },
            ],
          },
        },
      ],
    });
    expect(out[3]).toMatchObject({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    });
  });

  it("refusal stop_reason maps to content_filter", () => {
    const out = drain([
      {
        type: "message_start",
        message: {
          id: "msg_3",
          model: "claude-3-5",
          role: "assistant",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "refusal", stop_sequence: null },
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    ]);
    expect(out[1]).toMatchObject({
      choices: [{ finish_reason: "content_filter" }],
    });
  });

  it("emits a fallback terminator on onEnd when message_stop is missing", () => {
    const t = makeAnthropicToChatStream({ now: NOW });
    t.onEvent({
      type: "message_start",
      message: {
        id: "msg_4",
        model: "claude-3-5",
        role: "assistant",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    const tail = t.onEnd();
    expect(tail.at(-1)).toBe("[DONE]");
    expect(tail.at(-2)).toMatchObject({
      choices: [{ finish_reason: "stop" }],
    });
  });

  it("onError emits a synthetic content delta + terminator", () => {
    const t = makeAnthropicToChatStream({ now: NOW });
    t.onEvent({
      type: "message_start",
      message: {
        id: "msg_5",
        model: "claude-3-5",
        role: "assistant",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    const out = t.onError({ kind: "TimeoutError", message: "took too long" });
    expect(out[0]).toMatchObject({
      choices: [
        {
          delta: { content: expect.stringContaining("[upstream_error") },
          finish_reason: "stop",
        },
      ],
    });
    expect(out[1]).toBe("[DONE]");
  });

  it("ping events are silently dropped", () => {
    const t = makeAnthropicToChatStream({ now: NOW });
    expect(t.onEvent({ type: "ping" })).toEqual([]);
  });
});

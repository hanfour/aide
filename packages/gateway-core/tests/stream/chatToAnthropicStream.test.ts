import { describe, it, expect } from "vitest";
import {
  makeChatToAnthropicStream,
  type ChatStreamChunk,
  type ChatStreamInput,
} from "../../src/translate/stream/chatToAnthropicStream.js";

function drain(events: ChatStreamInput[]) {
  const t = makeChatToAnthropicStream();
  const out = events.flatMap((e) => t.onEvent(e));
  return [...out, ...t.onEnd()];
}

function chunk(
  delta: ChatStreamChunk["choices"][0]["delta"],
  finish: ChatStreamChunk["choices"][0]["finish_reason"] = null,
): ChatStreamChunk {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4-turbo",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

describe("makeChatToAnthropicStream", () => {
  it("text stream emits message_start + block_start + deltas + stop + message_delta + message_stop", () => {
    const out = drain([
      chunk({ role: "assistant" }),
      chunk({ content: "Hi " }),
      chunk({ content: "there" }),
      chunk({}, "stop"),
      "[DONE]",
    ]);
    expect(out[0]).toMatchObject({ type: "message_start" });
    expect(out[1]).toMatchObject({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    });
    expect(out[2]).toMatchObject({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hi " },
    });
    expect(out[3]).toMatchObject({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "there" },
    });
    expect(out[4]).toMatchObject({ type: "content_block_stop" });
    expect(out[5]).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    });
    expect(out[6]).toMatchObject({ type: "message_stop" });
  });

  it("tool_call stream opens a tool_use block + emits arg deltas + closes", () => {
    const out = drain([
      chunk({ role: "assistant" }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "" },
          },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 0, function: { arguments: '{"q":"x"}' } },
        ],
      }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ]);
    expect(out[1]).toMatchObject({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "call_1", name: "lookup" },
    });
    expect(out[2]).toMatchObject({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
    });
    expect(out.at(-2)).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
    });
  });

  it("text → tool_use transition closes the text block before opening tool_use", () => {
    const out = drain([
      chunk({ content: "Calling tool..." }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_a",
            type: "function",
            function: { name: "f", arguments: "" },
          },
        ],
      }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ]);
    // Sequence around the transition:
    //  - block_start (text)
    //  - block_delta (text_delta)
    //  - block_stop (text)
    //  - block_start (tool_use)
    const textStop = out.findIndex(
      (e) => e.type === "content_block_stop" && e.index === 0,
    );
    const toolStart = out.findIndex(
      (e, i) =>
        i > textStop &&
        e.type === "content_block_start" &&
        e.content_block.type === "tool_use",
    );
    expect(textStop).toBeGreaterThan(0);
    expect(toolStart).toBeGreaterThan(textStop);
  });

  it("finish_reason content_filter → stop_reason refusal", () => {
    const out = drain([
      chunk({ content: "blocked" }),
      chunk({}, "content_filter"),
      "[DONE]",
    ]);
    expect(out.at(-2)).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "refusal" },
    });
  });

  it("usage block on terminal chunk surfaces in message_delta usage", () => {
    const t = makeChatToAnthropicStream();
    t.onEvent(chunk({ role: "assistant" }));
    t.onEvent(chunk({ content: "x" }));
    const terminal: ChatStreamChunk = {
      ...chunk({}, "stop"),
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    };
    const out = [...t.onEvent(terminal), ...t.onEvent("[DONE]")];
    const md = out.find((e) => e.type === "message_delta");
    expect(md).toMatchObject({
      type: "message_delta",
      usage: { output_tokens: 1 },
    });
  });

  it("onEnd without [DONE] still emits message_delta + message_stop", () => {
    const t = makeChatToAnthropicStream();
    t.onEvent(chunk({ role: "assistant" }));
    t.onEvent(chunk({ content: "abrupt" }));
    const tail = t.onEnd();
    expect(tail.find((e) => e.type === "message_stop")).toBeDefined();
  });
});

// Pivot stream translator smoke tests + dispatch-table coverage.
//
// Pivots compose two existing translators per design §10.6 — these
// tests verify the composition produces sensible end-to-end output
// without re-checking every state-machine branch (those are covered
// by the per-translator tests).

import { describe, it, expect } from "vitest";
import { makeChatToResponsesStream } from "../../src/translate/stream/chatToResponsesStream.js";
import { makeResponsesToChatStream } from "../../src/translate/stream/responsesToChatStream.js";
import {
  streamTranslators,
  makeStreamTranslator,
  type Direction,
  type Format,
} from "../../src/translate/dispatch.js";
import type { ChatStreamInput } from "../../src/translate/stream/chatToAnthropicStream.js";
import type { ResponsesSSEEvent } from "../../src/translate/stream/responsesSseTypes.js";

const NOW = () => 1700000000;

const ALL_FORMATS: Format[] = ["anthropic", "openai-chat", "openai-responses"];

describe("makeChatToResponsesStream (pivot)", () => {
  it("Chat text stream → Responses output_text deltas + completed", () => {
    const t = makeChatToResponsesStream({ now: NOW });
    const inputs: ChatStreamInput[] = [
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4-turbo",
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4-turbo",
        choices: [
          { index: 0, delta: { content: "hello" }, finish_reason: null },
        ],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4-turbo",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      "[DONE]",
    ];
    const out = inputs.flatMap((i) => t.onEvent(i));
    out.push(...t.onEnd());
    // Should contain a response.created at the start and a
    // response.completed at the end.
    expect(out[0]).toMatchObject({ type: "response.created" });
    expect(out.at(-1)).toMatchObject({
      type: "response.completed",
      response: { status: "completed" },
    });
    // Text content survives the pivot.
    expect(
      out.some(
        (e) => e.type === "response.output_text.delta" && e.delta === "hello",
      ),
    ).toBe(true);
  });
});

describe("makeResponsesToChatStream (pivot)", () => {
  it("Responses text stream → Chat content delta + finish stop + [DONE]", () => {
    const t = makeResponsesToChatStream({ now: NOW });
    const inputs: ResponsesSSEEvent[] = [
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
        delta: "world",
      },
      { type: "response.output_item.done", output_index: 0 },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          incomplete_details: null,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];
    const out = inputs.flatMap((i) => t.onEvent(i));
    out.push(...t.onEnd());
    // Should end with [DONE].
    expect(out.at(-1)).toBe("[DONE]");
    // Content should appear in some delta chunk.
    expect(
      out.some(
        (e) =>
          e !== "[DONE]" &&
          e.choices?.[0]?.delta?.content === "world",
      ),
    ).toBe(true);
  });
});

describe("streamTranslators dispatch table", () => {
  it("contains a factory for every 9 Format pairs", () => {
    for (const client of ALL_FORMATS) {
      for (const upstream of ALL_FORMATS) {
        const direction: Direction = `${client}->${upstream}`;
        expect(streamTranslators[direction]).toBeDefined();
      }
    }
  });

  it("makeStreamTranslator returns a fresh translator per call", () => {
    const a = makeStreamTranslator("openai-chat", "anthropic");
    const b = makeStreamTranslator("openai-chat", "anthropic");
    expect(a).not.toBe(b);
    expect(typeof a.onEvent).toBe("function");
  });

  it("same-format passthrough re-emits the input event verbatim", () => {
    const t = makeStreamTranslator("anthropic", "anthropic");
    const e = { type: "ping" };
    expect(t.onEvent(e as never)).toEqual([e]);
    expect(t.onEnd()).toEqual([]);
  });

  it("throws unknown_translate_direction on a malformed key", () => {
    expect(() =>
      makeStreamTranslator("bogus" as unknown as Format, "anthropic"),
    ).toThrow(/unknown_translate_direction/);
  });
});

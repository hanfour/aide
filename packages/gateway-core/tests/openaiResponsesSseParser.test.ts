import { describe, it, expect } from "vitest";
import {
  parseOpenAIResponsesSse,
  OpenAIResponsesSseParseError,
} from "../src/stream/openaiResponsesSseParser.js";
import type { ResponsesSSEEvent } from "../src/translate/stream/responsesSseTypes.js";

const enc = new TextEncoder();

async function* fromString(input: string): AsyncGenerator<Buffer> {
  yield Buffer.from(enc.encode(input));
}

async function* fromChunks(chunks: string[]): AsyncGenerator<Buffer> {
  for (const c of chunks) yield Buffer.from(enc.encode(c));
}

async function collect(
  source: AsyncIterable<Buffer>,
  opts: Parameters<typeof parseOpenAIResponsesSse>[1] = {},
): Promise<ResponsesSSEEvent[]> {
  const events: ResponsesSSEEvent[] = [];
  for await (const ev of parseOpenAIResponsesSse(source, opts)) {
    events.push(ev);
  }
  return events;
}

const responseCreated = `event: response.created\ndata: ${JSON.stringify({
  type: "response.created",
  response: { id: "resp_x", model: "gpt-4o", created_at: 1 },
})}\n\n`;

const outputItemMessage = `event: response.output_item.added\ndata: ${JSON.stringify({
  type: "response.output_item.added",
  output_index: 0,
  item: { type: "message", id: "msg_1", role: "assistant" },
})}\n\n`;

const contentPartAdded = `event: response.content_part.added\ndata: ${JSON.stringify({
  type: "response.content_part.added",
  output_index: 0,
  content_index: 0,
  part: { type: "output_text", text: "" },
})}\n\n`;

const textDelta = `event: response.output_text.delta\ndata: ${JSON.stringify({
  type: "response.output_text.delta",
  output_index: 0,
  content_index: 0,
  delta: "Hello",
})}\n\n`;

const outputItemDone = `event: response.output_item.done\ndata: ${JSON.stringify({
  type: "response.output_item.done",
  output_index: 0,
})}\n\n`;

const responseCompleted = `event: response.completed\ndata: ${JSON.stringify({
  type: "response.completed",
  response: {
    id: "resp_x",
    status: "completed",
    incomplete_details: null,
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  },
})}\n\n`;

describe("parseOpenAIResponsesSse", () => {
  it("parses a 6-event happy-path stream into typed events in order", async () => {
    const source = fromString(
      responseCreated +
        outputItemMessage +
        contentPartAdded +
        textDelta +
        outputItemDone +
        responseCompleted,
    );
    const events = await collect(source);
    expect(events.map((e) => e.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
  });

  it("preserves payload fields verbatim (no re-shaping)", async () => {
    const events = await collect(fromString(textDelta));
    const ev = events[0]!;
    expect(ev.type).toBe("response.output_text.delta");
    if (ev.type === "response.output_text.delta") {
      expect(ev.delta).toBe("Hello");
      expect(ev.output_index).toBe(0);
      expect(ev.content_index).toBe(0);
    }
  });

  it("captures terminal usage on response.completed", async () => {
    const events = await collect(fromString(responseCompleted));
    const ev = events[0]!;
    expect(ev.type).toBe("response.completed");
    if (ev.type === "response.completed") {
      expect(ev.response.usage).toMatchObject({
        input_tokens: 5,
        output_tokens: 1,
        total_tokens: 6,
      });
    }
  });

  it("buffers across chunk boundaries (partial frame)", async () => {
    const half = textDelta.slice(0, textDelta.length - 5);
    const tail = textDelta.slice(textDelta.length - 5);
    const events = await collect(fromChunks([half, tail]));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("response.output_text.delta");
  });

  it("drops unknown event types and reports them via onUnknownEvent", async () => {
    const unknown = `event: response.web_search_call.delta\ndata: ${JSON.stringify({
      type: "response.web_search_call.delta",
      output_index: 0,
      delta: "...",
    })}\n\n`;
    const seen: string[] = [];
    const events = await collect(fromString(unknown + textDelta), {
      onUnknownEvent: (name) => seen.push(name),
    });
    expect(events.map((e) => e.type)).toEqual([
      "response.output_text.delta",
    ]);
    expect(seen).toEqual(["response.web_search_call.delta"]);
  });

  it("strict=true throws on malformed JSON data", async () => {
    const bad = `event: response.output_text.delta\ndata: not json\n\n`;
    await expect(collect(fromString(bad), { strict: true })).rejects.toThrow(
      OpenAIResponsesSseParseError,
    );
  });

  it("strict=false skips malformed JSON via onError", async () => {
    const bad = `event: response.output_text.delta\ndata: not json\n\n`;
    const errs: OpenAIResponsesSseParseError[] = [];
    const events = await collect(fromString(bad + textDelta), {
      strict: false,
      onError: (e) => errs.push(e),
    });
    expect(events.map((e) => e.type)).toEqual([
      "response.output_text.delta",
    ]);
    expect(errs).toHaveLength(1);
  });

  it("ignores SSE comments + multi-line data joins with newlines", async () => {
    const ev = `: keepalive\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"li`;
    const ev2 = `ne1"}\n\n`;
    const events = await collect(fromChunks([ev, ev2]));
    expect(events).toHaveLength(1);
    if (events[0]!.type === "response.output_text.delta") {
      expect(events[0]!.delta).toBe("line1");
    }
  });

  it("error event passes through as ResponsesEventError", async () => {
    const errorEv = `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { kind: "rate_limit_exceeded", message: "too many requests" },
    })}\n\n`;
    const events = await collect(fromString(errorEv));
    expect(events).toHaveLength(1);
    if (events[0]!.type === "error") {
      expect(events[0]!.error).toEqual({
        kind: "rate_limit_exceeded",
        message: "too many requests",
      });
    }
  });

  it("dispatches by JSON `type`, not by SSE `event:` name (defense)", async () => {
    // Some upstreams may not emit `event:` lines and rely on JSON type
    // alone; the parser dispatches off `data.type`.
    const noEventLine = `data: ${JSON.stringify({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "no-event-name",
    })}\n\n`;
    const events = await collect(fromString(noEventLine));
    expect(events).toHaveLength(1);
    if (events[0]!.type === "response.output_text.delta") {
      expect(events[0]!.delta).toBe("no-event-name");
    }
  });
});

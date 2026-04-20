import { describe, it, expect, vi } from "vitest";
import {
  parseAnthropicSse,
  SseParseError,
  type AnthropicSSEEvent,
  type MessageStartEvent,
  type ContentBlockStartEvent,
  type ContentBlockDeltaEvent,
  type ContentBlockStopEvent,
  type MessageDeltaEvent,
  type MessageStopEvent,
  type ErrorEvent,
  type PingEvent,
} from "../src/stream/anthropicSseParser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* fromChunks(...chunks: string[]): AsyncGenerator<Buffer> {
  for (const c of chunks) yield Buffer.from(c, "utf8");
}

async function collect(
  gen: AsyncGenerator<AnthropicSSEEvent>,
): Promise<AnthropicSSEEvent[]> {
  const out: AnthropicSSEEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseAnthropicSse", () => {
  // 1. Single complete event
  it("parses a single complete event", async () => {
    const events = await collect(
      parseAnthropicSse(fromChunks('event: ping\ndata: {"type":"ping"}\n\n')),
    );
    expect(events).toEqual([{ type: "ping" }]);
  });

  // 2. Multiple events in one chunk
  it("parses multiple events from a single chunk", async () => {
    const chunk =
      'data: {"type":"ping"}\n\n' +
      'data: {"type":"ping"}\n\n' +
      'data: {"type":"message_stop"}\n\n';
    const events = await collect(parseAnthropicSse(fromChunks(chunk)));
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "ping" });
    expect(events[1]).toEqual({ type: "ping" });
    expect(events[2]).toEqual({ type: "message_stop" });
  });

  // 3. Event split across chunks
  it("handles an event split across two chunks", async () => {
    const full = 'data: {"type":"ping"}\n\n';
    const half = Math.floor(full.length / 2);
    const events = await collect(
      parseAnthropicSse(fromChunks(full.slice(0, half), full.slice(half))),
    );
    expect(events).toEqual([{ type: "ping" }]);
  });

  // 4. Multi-byte UTF-8 character split across chunks
  it("handles multi-byte UTF-8 chars split across chunks", async () => {
    const text = "héllo";
    const jsonStr = `{"type":"ping","_t":"${text}"}`;
    const raw = `data: ${jsonStr}\n\n`;
    const bytes = Buffer.from(raw, "utf8");
    // Split in the middle of the 2-byte 'é' (at byte offset 7)
    const splitAt = raw.indexOf("é") + 1; // mid multi-byte char
    const part1 = bytes.subarray(0, splitAt);
    const part2 = bytes.subarray(splitAt);

    async function* fromBuffers(...bufs: Buffer[]): AsyncGenerator<Buffer> {
      for (const b of bufs) yield b;
    }

    const events = await collect(parseAnthropicSse(fromBuffers(part1, part2)));
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as { _t: string })._t).toBe(text);
  });

  // 5. CRLF line endings
  it("normalizes CRLF line endings to produce the same output as LF", async () => {
    const crlfChunk = 'event: ping\r\ndata: {"type":"ping"}\r\n\r\n';
    const lfChunk = 'event: ping\ndata: {"type":"ping"}\n\n';
    const crlf = await collect(parseAnthropicSse(fromChunks(crlfChunk)));
    const lf = await collect(parseAnthropicSse(fromChunks(lfChunk)));
    expect(crlf).toEqual(lf);
    expect(crlf).toEqual([{ type: "ping" }]);
  });

  // 6. Comment lines ignored
  it("ignores comment lines and still yields the event", async () => {
    const chunk = ': heartbeat\ndata: {"type":"ping"}\n\n';
    const events = await collect(parseAnthropicSse(fromChunks(chunk)));
    expect(events).toEqual([{ type: "ping" }]);
  });

  // 7. Multi-line data fields joined with \n per W3C SSE spec
  it("joins multiple data: lines with \\n before JSON.parse", async () => {
    // Split a valid JSON object across three data: lines
    const chunk = "data: {\n" + 'data: "type":"ping"\n' + "data: }\n\n";
    const events = await collect(parseAnthropicSse(fromChunks(chunk)));
    expect(events).toEqual([{ type: "ping" }]);
  });

  // 8. Trailing whitespace / extra blank lines tolerated
  it("handles extra blank lines between events gracefully", async () => {
    const chunk =
      'data: {"type":"ping"}\n\n\n\n' + 'data: {"type":"message_stop"}\n\n';
    const events = await collect(parseAnthropicSse(fromChunks(chunk)));
    // Extra blank lines just produce extra flush attempts with empty dataLines (no-ops)
    expect(events).toEqual([{ type: "ping" }, { type: "message_stop" }]);
  });

  // 9. Malformed JSON in strict mode throws SseParseError
  it("throws SseParseError with .raw in strict mode on malformed JSON", async () => {
    const chunk = "data: {not valid json}\n\n";
    await expect(async () => {
      for await (const _ of parseAnthropicSse(fromChunks(chunk), {
        strict: true,
      })) {
        // drain
      }
    }).rejects.toBeInstanceOf(SseParseError);

    try {
      for await (const _ of parseAnthropicSse(fromChunks(chunk), {
        strict: true,
      })) {
        // drain
      }
    } catch (err) {
      expect(err).toBeInstanceOf(SseParseError);
      expect((err as SseParseError).raw).toBe("{not valid json}");
    }
  });

  // 10. Malformed JSON in non-strict mode calls onError and continues
  it("skips bad event and yields next valid event in non-strict mode", async () => {
    const onError = vi.fn();
    const chunk = "data: {not valid json}\n\n" + 'data: {"type":"ping"}\n\n';
    const events = await collect(
      parseAnthropicSse(fromChunks(chunk), { strict: false, onError }),
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(SseParseError);
    expect(events).toEqual([{ type: "ping" }]);
  });

  // 11. Stream ends mid-event without trailing blank line — still flushes
  it("flushes accumulated data when stream ends without trailing blank line", async () => {
    const chunk = 'data: {"type":"ping"}';
    const events = await collect(parseAnthropicSse(fromChunks(chunk)));
    expect(events).toEqual([{ type: "ping" }]);
  });

  // 12. Empty stream yields nothing
  it("yields nothing for an empty stream", async () => {
    const events = await collect(parseAnthropicSse(fromChunks()));
    expect(events).toEqual([]);
  });

  // 13. All 8 event types parse and discriminate correctly
  describe("all Anthropic SSE event types", () => {
    const messageStartEvent: MessageStartEvent = {
      type: "message_start",
      message: {
        id: "msg_123",
        model: "claude-3-5-sonnet-20241022",
        role: "assistant",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    };

    const contentBlockStartTextEvent: ContentBlockStartEvent = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    };

    const contentBlockStartToolUseEvent: ContentBlockStartEvent = {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_abc",
        name: "get_weather",
        input: {},
      },
    };

    const contentBlockDeltaTextEvent: ContentBlockDeltaEvent = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello!" },
    };

    const contentBlockDeltaJsonEvent: ContentBlockDeltaEvent = {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"loc' },
    };

    const contentBlockStopEvent: ContentBlockStopEvent = {
      type: "content_block_stop",
      index: 0,
    };

    const messageDeltaEvent: MessageDeltaEvent = {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 42 },
    };

    const messageStopEvent: MessageStopEvent = { type: "message_stop" };
    const errorEvent: ErrorEvent = {
      type: "error",
      error: { type: "overloaded_error", message: "server overloaded" },
    };
    const pingEvent: PingEvent = { type: "ping" };

    const allEvents = [
      messageStartEvent,
      contentBlockStartTextEvent,
      contentBlockStartToolUseEvent,
      contentBlockDeltaTextEvent,
      contentBlockDeltaJsonEvent,
      contentBlockStopEvent,
      messageDeltaEvent,
      messageStopEvent,
      errorEvent,
      pingEvent,
    ];

    it("parses all 10 event payloads (8 types, 2 with subtypes) correctly", async () => {
      const rawChunks = allEvents
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join("");
      const parsed = await collect(parseAnthropicSse(fromChunks(rawChunks)));
      expect(parsed).toHaveLength(10);
      expect(parsed).toEqual(allEvents);
    });

    it("discriminates message_start type", async () => {
      const chunk = `data: ${JSON.stringify(messageStartEvent)}\n\n`;
      const [e] = await collect(parseAnthropicSse(fromChunks(chunk)));
      expect(e!.type).toBe("message_start");
      const typed = e as MessageStartEvent;
      expect(typed.message.id).toBe("msg_123");
      expect(typed.message.usage.input_tokens).toBe(10);
    });

    it("discriminates content_block_start text type", async () => {
      const chunk = `data: ${JSON.stringify(contentBlockStartTextEvent)}\n\n`;
      const [e] = await collect(parseAnthropicSse(fromChunks(chunk)));
      expect(e!.type).toBe("content_block_start");
      const typed = e as ContentBlockStartEvent;
      expect(typed.content_block.type).toBe("text");
    });

    it("discriminates content_block_start tool_use type", async () => {
      const chunk = `data: ${JSON.stringify(contentBlockStartToolUseEvent)}\n\n`;
      const [e] = await collect(parseAnthropicSse(fromChunks(chunk)));
      expect(e!.type).toBe("content_block_start");
      const typed = e as ContentBlockStartEvent;
      if (typed.content_block.type === "tool_use") {
        expect(typed.content_block.name).toBe("get_weather");
      } else {
        throw new Error("Expected tool_use block");
      }
    });

    it("discriminates content_block_delta text_delta", async () => {
      const chunk = `data: ${JSON.stringify(contentBlockDeltaTextEvent)}\n\n`;
      const [e] = await collect(parseAnthropicSse(fromChunks(chunk)));
      expect(e!.type).toBe("content_block_delta");
      const typed = e as ContentBlockDeltaEvent;
      if (typed.delta.type === "text_delta") {
        expect(typed.delta.text).toBe("Hello!");
      } else {
        throw new Error("Expected text_delta");
      }
    });

    it("discriminates content_block_delta input_json_delta", async () => {
      const chunk = `data: ${JSON.stringify(contentBlockDeltaJsonEvent)}\n\n`;
      const [e] = await collect(parseAnthropicSse(fromChunks(chunk)));
      expect(e!.type).toBe("content_block_delta");
      const typed = e as ContentBlockDeltaEvent;
      if (typed.delta.type === "input_json_delta") {
        expect(typed.delta.partial_json).toBe('{"loc');
      } else {
        throw new Error("Expected input_json_delta");
      }
    });

    it("discriminates content_block_stop", async () => {
      const chunk = `data: ${JSON.stringify(contentBlockStopEvent)}\n\n`;
      const [e] = await collect(parseAnthropicSse(fromChunks(chunk)));
      expect(e!.type).toBe("content_block_stop");
      expect((e as ContentBlockStopEvent).index).toBe(0);
    });

    it("discriminates message_delta", async () => {
      const chunk = `data: ${JSON.stringify(messageDeltaEvent)}\n\n`;
      const [e] = await collect(parseAnthropicSse(fromChunks(chunk)));
      expect(e!.type).toBe("message_delta");
      const typed = e as MessageDeltaEvent;
      expect(typed.delta.stop_reason).toBe("end_turn");
      expect(typed.usage.output_tokens).toBe(42);
    });

    it("discriminates message_stop", async () => {
      const chunk = `data: ${JSON.stringify(messageStopEvent)}\n\n`;
      const [e] = await collect(parseAnthropicSse(fromChunks(chunk)));
      expect(e).toEqual({ type: "message_stop" });
    });

    it("discriminates error event", async () => {
      const chunk = `data: ${JSON.stringify(errorEvent)}\n\n`;
      const [e] = await collect(parseAnthropicSse(fromChunks(chunk)));
      expect(e!.type).toBe("error");
      const typed = e as ErrorEvent;
      expect(typed.error.type).toBe("overloaded_error");
      expect(typed.error.message).toBe("server overloaded");
    });

    it("discriminates ping event", async () => {
      const chunk = `data: ${JSON.stringify(pingEvent)}\n\n`;
      const [e] = await collect(parseAnthropicSse(fromChunks(chunk)));
      expect(e).toEqual({ type: "ping" });
    });
  });
});

/**
 * Unit tests for `runtime/streamUsageExtractor.ts` — the push-mode SSE
 * extractor used by the streaming `/v1/messages` path to build a usage-log
 * snapshot without interfering with SmartBuffer passthrough (Plan 4A Part 7,
 * Sub-task C).
 *
 * Covers:
 *   - Single complete event → extract model + usage
 *   - Multiple events in one chunk, including message_start + message_delta
 *   - Chunk boundaries at arbitrary positions (mid-event, mid-line, mid-JSON)
 *   - Malformed JSON silently ignored (snapshot retains prior state)
 *   - Data-only frames (no `event:` line) still classified via JSON `type`
 *   - `message_delta` before `message_start` (defensive) — no throw, snapshot
 *     falls back to start values once start arrives
 *   - Empty input (no push) → all-zero snapshot, empty-string model
 *   - CRLF line endings normalised correctly
 *   - Missing cache token fields default to 0
 *   - Final output_tokens comes from LAST message_delta when multiple arrive
 *   - Snapshots are immutable (mutating the returned object does not leak)
 */

import { describe, it, expect } from "vitest";
import { StreamUsageExtractor } from "../../src/runtime/streamUsageExtractor.js";

function makeMessageStart(
  model = "claude-3-5-haiku-20241022",
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } = { input_tokens: 100, output_tokens: 1 },
): string {
  const data = {
    type: "message_start",
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        ...(usage.cache_creation_input_tokens !== undefined && {
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
        }),
        ...(usage.cache_read_input_tokens !== undefined && {
          cache_read_input_tokens: usage.cache_read_input_tokens,
        }),
      },
    },
  };
  return `event: message_start\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeMessageDelta(outputTokens: number): string {
  const data = {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  };
  return `event: message_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

function makePing(): string {
  return `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`;
}

describe("StreamUsageExtractor", () => {
  it("1. single message_start event — extracts model + all usage fields", () => {
    const x = new StreamUsageExtractor();
    x.push(
      Buffer.from(
        makeMessageStart("claude-3-5-haiku-20241022", {
          input_tokens: 123,
          output_tokens: 4,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 2,
        }),
      ),
    );
    expect(x.snapshot()).toEqual({
      model: "claude-3-5-haiku-20241022",
      input_tokens: 123,
      output_tokens: 4,
      cache_creation_tokens: 7,
      cache_read_tokens: 2,
    });
  });

  it("2. message_start followed by message_delta — output_tokens from delta wins", () => {
    const x = new StreamUsageExtractor();
    x.push(
      Buffer.from(
        makeMessageStart("m", { input_tokens: 10, output_tokens: 1 }),
      ),
    );
    x.push(Buffer.from(makeMessageDelta(42)));
    const snap = x.snapshot();
    expect(snap.model).toBe("m");
    expect(snap.input_tokens).toBe(10);
    expect(snap.output_tokens).toBe(42);
  });

  it("3. multiple message_delta events — LAST output_tokens wins (running final count)", () => {
    const x = new StreamUsageExtractor();
    x.push(
      Buffer.from(makeMessageStart("m", { input_tokens: 5, output_tokens: 0 })),
    );
    x.push(Buffer.from(makeMessageDelta(1)));
    x.push(Buffer.from(makeMessageDelta(10)));
    x.push(Buffer.from(makeMessageDelta(50)));
    expect(x.snapshot().output_tokens).toBe(50);
  });

  it("4. chunked at arbitrary byte boundaries — partial events buffered until complete", () => {
    const full =
      makeMessageStart("m", { input_tokens: 1000, output_tokens: 1 }) +
      makePing() +
      makeMessageDelta(500);
    const x = new StreamUsageExtractor();
    const bytes = Buffer.from(full);
    // Feed one byte at a time — worst-case boundary stress.
    for (let i = 0; i < bytes.length; i++) {
      x.push(bytes.subarray(i, i + 1));
    }
    expect(x.snapshot()).toEqual({
      model: "m",
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
  });

  it("5. malformed JSON in data — silently ignored, prior state preserved", () => {
    const x = new StreamUsageExtractor();
    x.push(
      Buffer.from(makeMessageStart("m", { input_tokens: 9, output_tokens: 0 })),
    );
    // Feed a bogus frame.
    x.push(Buffer.from("event: message_delta\ndata: {not json}\n\n"));
    // Follow with a valid delta to confirm extractor still works after bad input.
    x.push(Buffer.from(makeMessageDelta(3)));
    expect(x.snapshot()).toEqual({
      model: "m",
      input_tokens: 9,
      output_tokens: 3,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
  });

  it("6. data-only frame (no event: line) — classified via JSON type field", () => {
    const x = new StreamUsageExtractor();
    const data = JSON.stringify({
      type: "message_start",
      message: {
        model: "data-only-model",
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    });
    x.push(Buffer.from(`data: ${data}\n\n`));
    expect(x.snapshot().model).toBe("data-only-model");
    expect(x.snapshot().input_tokens).toBe(7);
  });

  it("7. message_delta before message_start — no throw; snapshot updates when start arrives", () => {
    const x = new StreamUsageExtractor();
    // Delta arrives first (defensive test — upstream ordering bug).
    x.push(Buffer.from(makeMessageDelta(99)));
    expect(x.snapshot()).toEqual({
      model: "",
      input_tokens: 0,
      output_tokens: 99,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
    // Then start arrives — model + input_tokens populate, cache fields stay 0.
    x.push(
      Buffer.from(
        makeMessageStart("late-m", { input_tokens: 11, output_tokens: 0 }),
      ),
    );
    expect(x.snapshot()).toEqual({
      model: "late-m",
      input_tokens: 11,
      output_tokens: 99, // delta still dominates
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
  });

  it("8. no push calls — snapshot returns all-zero + empty model", () => {
    const x = new StreamUsageExtractor();
    expect(x.snapshot()).toEqual({
      model: "",
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
  });

  it("9. CRLF line endings — normalised to LF, events still parsed", () => {
    const x = new StreamUsageExtractor();
    const data = JSON.stringify({
      type: "message_start",
      message: {
        model: "crlf-m",
        usage: { input_tokens: 50, output_tokens: 0 },
      },
    });
    // Use Windows-style line endings throughout.
    x.push(Buffer.from(`event: message_start\r\ndata: ${data}\r\n\r\n`));
    expect(x.snapshot().model).toBe("crlf-m");
    expect(x.snapshot().input_tokens).toBe(50);
  });

  it("10. output_tokens falls back to message_start when no delta arrives", () => {
    const x = new StreamUsageExtractor();
    // Upstream truncated after message_start — delta never arrives.
    x.push(
      Buffer.from(makeMessageStart("m", { input_tokens: 5, output_tokens: 8 })),
    );
    expect(x.snapshot().output_tokens).toBe(8);
  });

  it("11. event split across two pushes at the blank-line boundary", () => {
    const x = new StreamUsageExtractor();
    const full = makeMessageStart("split-m", {
      input_tokens: 77,
      output_tokens: 0,
    });
    // Split right before the trailing \n\n — first push has complete data lines
    // but no terminator yet, second push delivers just the blank line.
    const splitAt = full.length - 2;
    x.push(Buffer.from(full.slice(0, splitAt)));
    // No event consumed yet — model still empty.
    expect(x.snapshot().model).toBe("");
    x.push(Buffer.from(full.slice(splitAt)));
    expect(x.snapshot().model).toBe("split-m");
    expect(x.snapshot().input_tokens).toBe(77);
  });

  it("12. irrelevant events (ping, content_block_*) are silently ignored", () => {
    const x = new StreamUsageExtractor();
    x.push(Buffer.from(makePing()));
    x.push(
      Buffer.from(
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      ),
    );
    x.push(
      Buffer.from(
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      ),
    );
    // No message_start yet — snapshot still zero.
    expect(x.snapshot()).toEqual({
      model: "",
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
  });

  it("13. snapshot returns a fresh object each call — mutation does not leak", () => {
    const x = new StreamUsageExtractor();
    x.push(
      Buffer.from(makeMessageStart("m", { input_tokens: 1, output_tokens: 0 })),
    );
    const s1 = x.snapshot();
    s1.model = "mutated";
    s1.input_tokens = 999;
    const s2 = x.snapshot();
    expect(s2.model).toBe("m");
    expect(s2.input_tokens).toBe(1);
  });

  it("14. empty buffer push (zero-length) — no-op", () => {
    const x = new StreamUsageExtractor();
    x.push(Buffer.alloc(0));
    expect(x.snapshot()).toEqual({
      model: "",
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
  });

  it("15. negative / non-numeric token fields are coerced to 0", () => {
    const x = new StreamUsageExtractor();
    const data = JSON.stringify({
      type: "message_start",
      message: {
        model: "bad-tokens",
        usage: {
          input_tokens: -5,
          output_tokens: "four",
          cache_creation_input_tokens: NaN,
          cache_read_input_tokens: 1.9,
        },
      },
    });
    x.push(Buffer.from(`data: ${data}\n\n`));
    const snap = x.snapshot();
    expect(snap.input_tokens).toBe(0);
    expect(snap.output_tokens).toBe(0);
    expect(snap.cache_creation_tokens).toBe(0);
    // 1.9 floors to 1 (consistent with toNonNegInt in usageLogging.ts).
    expect(snap.cache_read_tokens).toBe(1);
  });
});

// ── Transcript accumulator tests ───────────────────────────────────────────

/**
 * Helpers to construct Anthropic SSE event strings for the transcript tests.
 */
function makeContentBlockStart(
  index: number,
  block: { type: "text" } | { type: "tool_use"; id: string; name: string },
): string {
  return `event: content_block_start\ndata: ${JSON.stringify({
    type: "content_block_start",
    index,
    content_block: block,
  })}\n\n`;
}

function makeTextDelta(index: number, text: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  })}\n\n`;
}

function makeInputJsonDelta(index: number, partialJson: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  })}\n\n`;
}

function makeContentBlockStop(index: number): string {
  return `event: content_block_stop\ndata: ${JSON.stringify({
    type: "content_block_stop",
    index,
  })}\n\n`;
}

function makeMessageStop(): string {
  return `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
}

describe("StreamUsageExtractor — getAssembledTranscript()", () => {
  it("T1. no events — transcript has null id/model/usage and empty content", () => {
    const x = new StreamUsageExtractor();
    const t = x.getAssembledTranscript();
    expect(t.id).toBeNull();
    expect(t.model).toBeNull();
    expect(t.role).toBe("assistant");
    expect(t.type).toBe("message");
    expect(t.content).toEqual([]);
    expect(t.stop_reason).toBeNull();
    expect(t.usage).toBeNull();
  });

  it("T2. message_start only — id/model/usage populated, content empty", () => {
    const x = new StreamUsageExtractor();
    const startData = JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-5-haiku-20241022",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 0 },
      },
    });
    x.push(Buffer.from(`event: message_start\ndata: ${startData}\n\n`));
    const t = x.getAssembledTranscript();
    expect(t.id).toBe("msg_01");
    expect(t.model).toBe("claude-3-5-haiku-20241022");
    expect(t.content).toEqual([]);
    expect(t.stop_reason).toBeNull();
    expect(t.usage).toEqual({
      input_tokens: 50,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("T3. text-only stream — assembled transcript matches expected shape", () => {
    const x = new StreamUsageExtractor();

    const startData = JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_text",
        model: "claude-3-5-sonnet-20241022",
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    x.push(Buffer.from(`event: message_start\ndata: ${startData}\n\n`));
    x.push(Buffer.from(makeContentBlockStart(0, { type: "text" })));
    x.push(Buffer.from(makeTextDelta(0, "Hello")));
    x.push(Buffer.from(makeTextDelta(0, ", world!")));
    x.push(Buffer.from(makeContentBlockStop(0)));

    const deltaData = JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    });
    x.push(Buffer.from(`event: message_delta\ndata: ${deltaData}\n\n`));
    x.push(Buffer.from(makeMessageStop()));

    const t = x.getAssembledTranscript();
    expect(t.id).toBe("msg_text");
    expect(t.model).toBe("claude-3-5-sonnet-20241022");
    expect(t.role).toBe("assistant");
    expect(t.type).toBe("message");
    expect(t.stop_reason).toBe("end_turn");
    expect(t.content).toEqual([{ type: "text", text: "Hello, world!" }]);
    expect(t.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("T4. tool_use stream — input JSON assembled from fragments and parsed", () => {
    const x = new StreamUsageExtractor();

    const startData = JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_tool",
        model: "claude-3-5-haiku-20241022",
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    });
    x.push(Buffer.from(`event: message_start\ndata: ${startData}\n\n`));
    x.push(
      Buffer.from(
        makeContentBlockStart(0, {
          type: "tool_use",
          id: "toolu_01",
          name: "get_weather",
        }),
      ),
    );
    // Fragmented JSON: {"location":"SF"} across three deltas
    x.push(Buffer.from(makeInputJsonDelta(0, '{"loc')));
    x.push(Buffer.from(makeInputJsonDelta(0, "ation")));
    x.push(Buffer.from(makeInputJsonDelta(0, '":"SF"}')));
    x.push(Buffer.from(makeContentBlockStop(0)));

    const deltaData = JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 20 },
    });
    x.push(Buffer.from(`event: message_delta\ndata: ${deltaData}\n\n`));
    x.push(Buffer.from(makeMessageStop()));

    const t = x.getAssembledTranscript();
    expect(t.content).toHaveLength(1);
    const block = t.content[0]!;
    expect(block.type).toBe("tool_use");
    if (block.type === "tool_use") {
      expect(block.id).toBe("toolu_01");
      expect(block.name).toBe("get_weather");
      expect(block.input).toEqual({ location: "SF" });
    } else {
      throw new Error("expected tool_use block");
    }
    expect(t.stop_reason).toBe("tool_use");
  });

  it("T5. mixed text + tool_use blocks — both captured in order", () => {
    const x = new StreamUsageExtractor();

    const startData = JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_mixed",
        model: "claude-3-opus-20240229",
        usage: { input_tokens: 200, output_tokens: 0 },
      },
    });
    x.push(Buffer.from(`event: message_start\ndata: ${startData}\n\n`));

    // Block 0: text
    x.push(Buffer.from(makeContentBlockStart(0, { type: "text" })));
    x.push(Buffer.from(makeTextDelta(0, "I'll check that for you.")));
    x.push(Buffer.from(makeContentBlockStop(0)));

    // Block 1: tool_use
    x.push(
      Buffer.from(
        makeContentBlockStart(1, {
          type: "tool_use",
          id: "toolu_02",
          name: "web_search",
        }),
      ),
    );
    x.push(Buffer.from(makeInputJsonDelta(1, '{"query":"TypeScript"}')));
    x.push(Buffer.from(makeContentBlockStop(1)));

    const t = x.getAssembledTranscript();
    expect(t.content).toHaveLength(2);
    expect(t.content[0]).toEqual({
      type: "text",
      text: "I'll check that for you.",
    });
    expect(t.content[1]).toEqual({
      type: "tool_use",
      id: "toolu_02",
      name: "web_search",
      input: { query: "TypeScript" },
    });
  });

  it("T6. tool_use with malformed partial JSON (mid-stream cut) — raw string captured", () => {
    const x = new StreamUsageExtractor();
    x.push(
      Buffer.from(
        makeContentBlockStart(0, {
          type: "tool_use",
          id: "toolu_03",
          name: "fn",
        }),
      ),
    );
    // Only partial JSON delivered — stream cut
    x.push(Buffer.from(makeInputJsonDelta(0, '{"incomplete')));
    x.push(Buffer.from(makeContentBlockStop(0)));

    const t = x.getAssembledTranscript();
    expect(t.content).toHaveLength(1);
    const block = t.content[0]!;
    expect(block.type).toBe("tool_use");
    if (block.type === "tool_use") {
      // Fallback: raw string preserved for forensics
      expect(block.input).toBe('{"incomplete');
    } else {
      throw new Error("expected tool_use block");
    }
  });

  it("T7. getAssembledTranscript() returns fresh object each call — immutable snapshot", () => {
    const x = new StreamUsageExtractor();
    x.push(Buffer.from(makeContentBlockStart(0, { type: "text" })));
    x.push(Buffer.from(makeTextDelta(0, "hi")));
    x.push(Buffer.from(makeContentBlockStop(0)));

    const t1 = x.getAssembledTranscript();
    // Mutate t1 — should not affect t2
    t1.content = [];
    (t1 as { id: string | null }).id = "mutated";

    const t2 = x.getAssembledTranscript();
    expect(t2.content).toHaveLength(1);
    expect(t2.id).toBeNull();
  });

  it("T8. chunked at byte boundaries — transcript still assembled correctly", () => {
    const startData = JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_chunked",
        model: "claude-m",
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    });
    const full =
      `event: message_start\ndata: ${startData}\n\n` +
      makeContentBlockStart(0, { type: "text" }) +
      makeTextDelta(0, "chunk") +
      makeContentBlockStop(0);

    const x = new StreamUsageExtractor();
    const bytes = Buffer.from(full);
    // Feed one byte at a time.
    for (let i = 0; i < bytes.length; i++) {
      x.push(bytes.subarray(i, i + 1));
    }

    const t = x.getAssembledTranscript();
    expect(t.id).toBe("msg_chunked");
    expect(t.content).toEqual([{ type: "text", text: "chunk" }]);
  });
});

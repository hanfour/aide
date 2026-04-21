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
    x.push(Buffer.from(makeMessageStart("m", { input_tokens: 10, output_tokens: 1 })));
    x.push(Buffer.from(makeMessageDelta(42)));
    const snap = x.snapshot();
    expect(snap.model).toBe("m");
    expect(snap.input_tokens).toBe(10);
    expect(snap.output_tokens).toBe(42);
  });

  it("3. multiple message_delta events — LAST output_tokens wins (running final count)", () => {
    const x = new StreamUsageExtractor();
    x.push(Buffer.from(makeMessageStart("m", { input_tokens: 5, output_tokens: 0 })));
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
    x.push(Buffer.from(makeMessageStart("m", { input_tokens: 9, output_tokens: 0 })));
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
    x.push(Buffer.from(makeMessageStart("late-m", { input_tokens: 11, output_tokens: 0 })));
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
    x.push(Buffer.from(makeMessageStart("m", { input_tokens: 5, output_tokens: 8 })));
    expect(x.snapshot().output_tokens).toBe(8);
  });

  it("11. event split across two pushes at the blank-line boundary", () => {
    const x = new StreamUsageExtractor();
    const full = makeMessageStart("split-m", { input_tokens: 77, output_tokens: 0 });
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
    x.push(Buffer.from(makeMessageStart("m", { input_tokens: 1, output_tokens: 0 })));
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

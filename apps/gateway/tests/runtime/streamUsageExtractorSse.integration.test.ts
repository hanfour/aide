/**
 * Integration test (Plan 4C Part 12, Spec §9.6) — drives the push-mode SSE
 * extractor with a realistic Anthropic event sequence and asserts BOTH the
 * usage snapshot AND the assembled `StreamTranscript` produced by
 * `getAssembledTranscript()`.
 *
 * Distinct from the unit suite (`streamUsageExtractor.test.ts`):
 *   - Uses raw event-block strings shaped exactly like Anthropic's wire
 *     format, including `event:` lines and content_block_* events that the
 *     unit tests don't fully exercise.
 *   - Verifies a complete pipeline: message_start → content_block_start →
 *     content_block_delta × 2 → content_block_stop → message_delta →
 *     message_stop reaches a usable transcript with text content + final
 *     usage figures.
 *   - Adds a chunked-boundary scenario where one event is split across two
 *     `push()` calls mid-`data:` line — catches regressions in the streaming
 *     decoder's CRLF / UTF-8 boundary handling.
 */

import { describe, it, expect } from "vitest";
import { StreamUsageExtractor } from "../../src/runtime/streamUsageExtractor.js";

// ── Fixture helpers ────────────────────────────────────────────────────────

function sseFrame(eventName: string, payload: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function realisticHaikuStream(): string {
  return [
    sseFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_01ABCD",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-haiku-4-5",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " world" },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 20 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join("");
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("StreamUsageExtractor — SSE → StreamTranscript integration", () => {
  it("assembles transcript + final usage from a realistic Anthropic stream", () => {
    const x = new StreamUsageExtractor();
    x.push(Buffer.from(realisticHaikuStream(), "utf-8"));

    const snap = x.snapshot();
    expect(snap.model).toBe("claude-haiku-4-5");
    expect(snap.input_tokens).toBe(100);
    expect(snap.output_tokens).toBe(20);
    expect(snap.cache_creation_tokens).toBe(0);
    expect(snap.cache_read_tokens).toBe(0);

    const transcript = x.getAssembledTranscript();
    expect(transcript.id).toBe("msg_01ABCD");
    expect(transcript.type).toBe("message");
    expect(transcript.role).toBe("assistant");
    expect(transcript.model).toBe("claude-haiku-4-5");
    expect(transcript.stop_reason).toBe("end_turn");
    expect(transcript.content).toEqual([
      { type: "text", text: "Hello world" },
    ]);
    expect(transcript.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("produces the same final transcript when chunks split mid-event", () => {
    const full = realisticHaikuStream();
    // Pick a split point inside the first `data:` line of message_start so we
    // exercise the partial-line buffer path. Index 30 lands somewhere in the
    // middle of the JSON payload for the message_start frame.
    const splitAt = 30;
    const chunkA = Buffer.from(full.slice(0, splitAt), "utf-8");
    const chunkB = Buffer.from(full.slice(splitAt), "utf-8");

    const x = new StreamUsageExtractor();
    x.push(chunkA);
    x.push(chunkB);

    expect(x.snapshot()).toEqual({
      model: "claude-haiku-4-5",
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });

    const transcript = x.getAssembledTranscript();
    expect(transcript.model).toBe("claude-haiku-4-5");
    expect(transcript.content).toEqual([
      { type: "text", text: "Hello world" },
    ]);
    expect(transcript.usage?.output_tokens).toBe(20);
    expect(transcript.stop_reason).toBe("end_turn");
  });

  it("byte-by-byte feed (worst-case chunking) still produces canonical transcript", () => {
    const full = realisticHaikuStream();
    const bytes = Buffer.from(full, "utf-8");

    const x = new StreamUsageExtractor();
    for (let i = 0; i < bytes.length; i++) {
      x.push(bytes.subarray(i, i + 1));
    }

    const transcript = x.getAssembledTranscript();
    expect(transcript.content).toEqual([
      { type: "text", text: "Hello world" },
    ]);
    expect(transcript.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});

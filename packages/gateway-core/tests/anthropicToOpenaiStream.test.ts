import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { translateAnthropicStreamToOpenAI } from "../src/translate/anthropicToOpenaiStream";
import type { AnthropicSSEEvent } from "../src/translate/anthropicToOpenaiStream";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadEvents(name: string): AnthropicSSEEvent[] {
  const filePath = join(
    __dirname,
    "..",
    "test",
    "fixtures",
    "streams",
    `${name}.events.json`,
  );
  return JSON.parse(readFileSync(filePath, "utf8")) as AnthropicSSEEvent[];
}

function loadChunks(name: string): unknown[] {
  const filePath = join(
    __dirname,
    "..",
    "test",
    "fixtures",
    "streams",
    `${name}.chunks.json`,
  );
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown[];
}

async function* toAsyncIterable(
  events: AnthropicSSEEvent[],
): AsyncIterable<AnthropicSSEEvent> {
  for (const e of events) yield e;
}

async function collectChunks(name: string): Promise<unknown[]> {
  const events = loadEvents(name);
  const actual: unknown[] = [];
  for await (const chunk of translateAnthropicStreamToOpenAI(
    toAsyncIterable(events),
    { now: () => 1704067200 },
  )) {
    actual.push(chunk);
  }
  return actual;
}

// ---------------------------------------------------------------------------
// Fixture-driven tests
// ---------------------------------------------------------------------------

const FIXTURE_NAMES = [
  "plain-text",
  "text-plus-one-tool",
  "two-tools",
  "max-tokens-truncated",
] as const;

describe("translateAnthropicStreamToOpenAI — fixture tests", () => {
  for (const name of FIXTURE_NAMES) {
    it(`matches expected output: ${name}`, async () => {
      const actual = await collectChunks(name);
      const expected = loadChunks(name);
      expect(actual).toEqual(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("translateAnthropicStreamToOpenAI — error handling", () => {
  it("throws on mid-stream error event and emits prior chunks", async () => {
    const events = loadEvents("mid-stream-error");
    const expected = loadChunks("mid-stream-error");
    const emitted: unknown[] = [];

    await expect(async () => {
      for await (const chunk of translateAnthropicStreamToOpenAI(
        toAsyncIterable(events),
        { now: () => 1704067200 },
      )) {
        emitted.push(chunk);
      }
    }).rejects.toThrow(/server overloaded/);

    // Chunks emitted before the error must match the fixture
    expect(emitted).toEqual(expected);
  });

  it("throws with upstream error type in message", async () => {
    const events: AnthropicSSEEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_err_x",
          model: "claude-3-5-sonnet-20241022",
          role: "assistant",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "error",
        error: { type: "rate_limit_error", message: "too many requests" },
      },
    ];

    await expect(async () => {
      for await (const _ of translateAnthropicStreamToOpenAI(
        toAsyncIterable(events),
      )) {
        // drain
      }
    }).rejects.toThrow(/rate_limit_error.*too many requests/);
  });
});

// ---------------------------------------------------------------------------
// Behavioral unit tests
// ---------------------------------------------------------------------------

describe("translateAnthropicStreamToOpenAI — behavioral", () => {
  it("emits [DONE] as the final yielded value", async () => {
    const events = loadEvents("plain-text");
    const chunks = await collectChunks("plain-text");
    expect(chunks[chunks.length - 1]).toBe("[DONE]");
  });

  it("first chunk has role:assistant on delta", async () => {
    const chunks = await collectChunks("plain-text");
    const first = chunks[0] as { choices: Array<{ delta: { role?: string } }> };
    expect(first.choices[0]!.delta.role).toBe("assistant");
  });

  it("ping events are dropped (produce no chunks)", async () => {
    // two-tools fixture has a ping event; compare chunk count vs no-ping equivalent
    const twoToolsChunks = await collectChunks("two-tools");
    // The ping should not appear in output — assert no chunk has type 'ping'
    for (const chunk of twoToolsChunks) {
      expect(chunk).not.toMatchObject({ type: "ping" });
    }
  });

  it("tool call indices are 0-based over tool_use blocks only (text block does not increment)", async () => {
    // text-plus-one-tool: text at index 0, tool_use at index 1 → tool_calls index = 0
    const events = loadEvents("text-plus-one-tool");
    const chunks = await collectChunks("text-plus-one-tool");
    const toolIntroChunk = chunks.find(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        (c as { choices?: Array<{ delta?: { tool_calls?: unknown[] } }> })
          .choices?.[0]?.delta?.tool_calls !== undefined &&
        (
          c as {
            choices: Array<{ delta: { tool_calls: Array<{ id?: string }> } }>;
          }
        ).choices[0]!.delta.tool_calls[0]?.id !== undefined,
    ) as
      | { choices: Array<{ delta: { tool_calls: Array<{ index: number }> } }> }
      | undefined;

    // toolIntroChunk is guaranteed to exist because the fixture has a tool_use block
    const toolChoice = toolIntroChunk!.choices[0]!.delta.tool_calls[0]!;
    expect(toolChoice.index).toBe(0);
  });

  it("two tool_use blocks get sequential OpenAI indices 0 and 1", async () => {
    const chunks = await collectChunks("two-tools");

    type IntroChunk = {
      choices: Array<{
        delta: { tool_calls: Array<{ index: number; id: string }> };
      }>;
    };
    const introChunks = chunks.filter(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        (
          c as {
            choices?: Array<{
              delta?: { tool_calls?: Array<{ id?: string }> };
            }>;
          }
        ).choices?.[0]?.delta?.tool_calls?.[0]?.id !== undefined,
    ) as IntroChunk[];

    expect(introChunks).toHaveLength(2);
    expect(introChunks[0]!.choices[0]!.delta.tool_calls[0]!.index).toBe(0);
    expect(introChunks[1]!.choices[0]!.delta.tool_calls[0]!.index).toBe(1);
  });

  it("usage on final chunk includes cache tokens in prompt_tokens", async () => {
    // two-tools fixture has cache_read_input_tokens:10, input_tokens:50 → prompt_tokens=60
    const chunks = await collectChunks("two-tools");
    const finalChunk = chunks[chunks.length - 2]! as {
      usage?: { prompt_tokens: number };
    };
    expect(finalChunk.usage!.prompt_tokens).toBe(60);
  });

  it("max_tokens stop_reason maps to finish_reason=length", async () => {
    const chunks = await collectChunks("max-tokens-truncated");
    const finalDataChunk = chunks[chunks.length - 2]! as {
      choices: Array<{ finish_reason: string }>;
    };
    expect(finalDataChunk.choices[0]!.finish_reason).toBe("length");
  });

  it("tool_use stop_reason maps to finish_reason=tool_calls", async () => {
    const chunks = await collectChunks("text-plus-one-tool");
    const finalDataChunk = chunks[chunks.length - 2]! as {
      choices: Array<{ finish_reason: string }>;
    };
    expect(finalDataChunk.choices[0]!.finish_reason).toBe("tool_calls");
  });
});

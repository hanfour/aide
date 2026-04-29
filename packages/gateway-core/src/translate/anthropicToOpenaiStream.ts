// Anthropic SSE → OpenAI SSE streaming translator.
// Consumes parsed Anthropic SSE events and yields OpenAI-compatible chunks.

import type { AnthropicSSEEvent } from "../stream/anthropicSseParser.js";

export type { AnthropicSSEEvent };

// ---------------------------------------------------------------------------
// OpenAI stream chunk type
// ---------------------------------------------------------------------------

interface ToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface StreamDelta {
  role?: "assistant";
  content?: string | null;
  tool_calls?: ToolCallDelta[];
}

export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: StreamDelta;
    finish_reason: null | "stop" | "length" | "tool_calls" | "content_filter";
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Translator state (intentionally local; immutability not applicable to
// the mutable accumulator, which is never exposed externally)
// ---------------------------------------------------------------------------

interface TranslatorState {
  id: string;
  model: string;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  /** Anthropic block index → OpenAI tool_calls array index */
  toolCallIndexByBlock: Map<number, number>;
  nextToolCallIndex: number;
  stopReason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "refusal"
    | null;
}

// ---------------------------------------------------------------------------
// Finish reason mapping
// ---------------------------------------------------------------------------

const FINISH_REASON_MAP: Record<
  string,
  "stop" | "length" | "tool_calls" | "content_filter"
> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Translates an async stream of parsed Anthropic SSE events into OpenAI-compatible
 * stream chunks. After the final data chunk, yields the string `'[DONE]'`.
 *
 * @param events - Parsed Anthropic SSE events (e.g. from a server-sent-events parser).
 * @param opts.now - Optional clock injection returning Unix seconds. Used for deterministic tests.
 *
 * @throws {Error} if an `error` event is encountered mid-stream.
 */
export async function* translateAnthropicStreamToOpenAI(
  events: AsyncIterable<AnthropicSSEEvent>,
  opts: { now?: () => number } = {},
): AsyncGenerator<OpenAIStreamChunk | "[DONE]", void, void> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  const state: TranslatorState = {
    id: "",
    model: "",
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    toolCallIndexByBlock: new Map(),
    nextToolCallIndex: 0,
    stopReason: null,
  };

  for await (const event of events) {
    switch (event.type) {
      case "message_start": {
        state.id = event.message.id;
        state.model = event.message.model;
        state.inputTokens = event.message.usage.input_tokens;
        state.cacheCreationInputTokens =
          event.message.usage.cache_creation_input_tokens ?? 0;
        state.cacheReadInputTokens =
          event.message.usage.cache_read_input_tokens ?? 0;

        yield buildChunk(state, now(), {
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        });
        break;
      }

      case "content_block_start": {
        if (event.content_block.type === "tool_use") {
          const toolCallIndex = state.nextToolCallIndex;
          state.toolCallIndexByBlock.set(event.index, toolCallIndex);
          state.nextToolCallIndex += 1;

          yield buildChunk(state, now(), {
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: event.content_block.id,
                  type: "function",
                  function: { name: event.content_block.name, arguments: "" },
                },
              ],
            },
            finish_reason: null,
          });
        }
        // text blocks: no output chunk — wait for deltas
        break;
      }

      case "content_block_delta": {
        if (event.delta.type === "text_delta") {
          yield buildChunk(state, now(), {
            delta: { content: event.delta.text },
            finish_reason: null,
          });
        } else if (event.delta.type === "input_json_delta") {
          const toolCallIndex = state.toolCallIndexByBlock.get(event.index);
          if (toolCallIndex === undefined) {
            throw new Error(
              `input_json_delta for unknown block index ${event.index}`,
            );
          }
          yield buildChunk(state, now(), {
            delta: {
              tool_calls: [
                {
                  index: toolCallIndex,
                  function: { arguments: event.delta.partial_json },
                },
              ],
            },
            finish_reason: null,
          });
        }
        break;
      }

      case "content_block_stop":
      case "ping": {
        // No output — intentionally dropped
        break;
      }

      case "message_delta": {
        state.stopReason = event.delta.stop_reason;
        state.outputTokens = event.usage.output_tokens;
        break;
      }

      case "message_stop": {
        const finishReason =
          FINISH_REASON_MAP[state.stopReason ?? ""] ?? "stop";
        const promptTokens =
          state.inputTokens +
          state.cacheCreationInputTokens +
          state.cacheReadInputTokens;
        const completionTokens = state.outputTokens;

        yield buildChunk(state, now(), {
          delta: {},
          finish_reason: finishReason,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        });

        yield "[DONE]";
        return;
      }

      case "error": {
        throw new Error(
          `upstream stream error: ${event.error.type}: ${event.error.message}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildChunk(
  state: Readonly<TranslatorState>,
  created: number,
  payload: {
    delta: StreamDelta;
    finish_reason: OpenAIStreamChunk["choices"][0]["finish_reason"];
    usage?: OpenAIStreamChunk["usage"];
  },
): OpenAIStreamChunk {
  const chunk: OpenAIStreamChunk = {
    id: state.id,
    object: "chat.completion.chunk",
    created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta: payload.delta,
        finish_reason: payload.finish_reason,
      },
    ],
  };

  if (payload.usage !== undefined) {
    chunk.usage = payload.usage;
  }

  return chunk;
}

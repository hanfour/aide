// Plan 5A Part 6 Task 6.10 — Anthropic SSE → OpenAI Chat SSE
// stream translator (push-based). Replaces 4A's async-generator
// `translateAnthropicStreamToOpenAI` with the StreamTranslator
// state-machine interface used by the dispatch table + pivots.
//
// State held: id, model, usage counters, tool-call index map, latest
// stop_reason. On `message_stop` we flush the final chunk + a
// `[DONE]` sentinel. The translator drains via `onEnd()` for the
// case where the upstream closes without a `message_stop` (fault
// handling — most upstreams always close cleanly).

import type { AnthropicSSEEvent } from "../../stream/anthropicSseParser.js";
import type { OpenAIStreamChunk } from "../anthropicToOpenaiStream.js";
import type { StreamTranslator } from "./types.js";

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

interface ChatChunkOrDone {
  /** A chat.completion.chunk frame, or the `[DONE]` sentinel. */
  payload: OpenAIStreamChunk | "[DONE]";
}

interface State {
  id: string;
  model: string;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  toolCallIndexByBlock: Map<number, number>;
  nextToolCallIndex: number;
  stopReason: string | null;
  /** Set once `[DONE]` has been emitted so onEnd is a no-op. */
  finished: boolean;
}

export function makeAnthropicToChatStream(
  opts: { now?: () => number } = {},
): StreamTranslator<AnthropicSSEEvent, ChatChunkOrDone["payload"]> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const state: State = {
    id: "",
    model: "",
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    toolCallIndexByBlock: new Map(),
    nextToolCallIndex: 0,
    stopReason: null,
    finished: false,
  };

  const buildChunk = (
    delta: OpenAIStreamChunk["choices"][0]["delta"],
    finishReason: OpenAIStreamChunk["choices"][0]["finish_reason"] = null,
    usage?: OpenAIStreamChunk["usage"],
  ): OpenAIStreamChunk => {
    const chunk: OpenAIStreamChunk = {
      id: state.id,
      object: "chat.completion.chunk",
      created: now(),
      model: state.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage !== undefined) chunk.usage = usage;
    return chunk;
  };

  return {
    onEvent(event) {
      if (state.finished) return [];
      switch (event.type) {
        case "message_start":
          state.id = event.message.id;
          state.model = event.message.model;
          state.inputTokens = event.message.usage.input_tokens;
          state.cacheCreationInputTokens =
            event.message.usage.cache_creation_input_tokens ?? 0;
          state.cacheReadInputTokens =
            event.message.usage.cache_read_input_tokens ?? 0;
          return [buildChunk({ role: "assistant", content: "" })];
        case "content_block_start": {
          if (event.content_block.type !== "tool_use") return [];
          const idx = state.nextToolCallIndex;
          state.toolCallIndexByBlock.set(event.index, idx);
          state.nextToolCallIndex += 1;
          return [
            buildChunk({
              tool_calls: [
                {
                  index: idx,
                  id: event.content_block.id,
                  type: "function",
                  function: {
                    name: event.content_block.name,
                    arguments: "",
                  },
                },
              ],
            }),
          ];
        }
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            return [buildChunk({ content: event.delta.text })];
          }
          if (event.delta.type === "input_json_delta") {
            const idx = state.toolCallIndexByBlock.get(event.index);
            if (idx === undefined) return [];
            return [
              buildChunk({
                tool_calls: [
                  {
                    index: idx,
                    function: { arguments: event.delta.partial_json },
                  },
                ],
              }),
            ];
          }
          return [];
        case "content_block_stop":
        case "ping":
          return [];
        case "message_delta":
          state.stopReason = event.delta.stop_reason;
          state.outputTokens = event.usage.output_tokens;
          return [];
        case "message_stop": {
          state.finished = true;
          const finishReason =
            FINISH_REASON_MAP[state.stopReason ?? ""] ?? "stop";
          const promptTokens =
            state.inputTokens +
            state.cacheCreationInputTokens +
            state.cacheReadInputTokens;
          return [
            buildChunk({}, finishReason, {
              prompt_tokens: promptTokens,
              completion_tokens: state.outputTokens,
              total_tokens: promptTokens + state.outputTokens,
            }),
            "[DONE]",
          ];
        }
        case "error":
          // Translators don't surface error events directly — the pipe
          // wrapper calls `onError` for upstream-level errors; an
          // SSE-level error event is treated the same way.
          return this.onError({
            kind: event.error.type,
            message: event.error.message,
          });
      }
    },
    onEnd() {
      // Upstream closed cleanly without `message_stop` — emit a
      // best-effort terminator so the client doesn't hang.
      if (state.finished) return [];
      state.finished = true;
      return [buildChunk({}, "stop"), "[DONE]"];
    },
    onError(err) {
      if (state.finished) return [];
      state.finished = true;
      return [
        buildChunk(
          { content: `\n[upstream_error: ${err.kind}: ${err.message}]` },
          "stop",
        ),
        "[DONE]",
      ];
    },
  };
}

export type ChatStreamEvent = OpenAIStreamChunk | "[DONE]";

// Plan 5A Part 6 Task 6.10 — Anthropic SSE → OpenAI Responses SSE
// stream translator.
//
// Anthropic emits a flat ladder of content_block_* events; Responses
// uses a nested output_index / content_index hierarchy.  Mapping:
//
//   message_start → response.created
//   content_block_start (text)
//     → response.output_item.added (message)
//     → response.content_part.added (output_text)
//   content_block_delta (text_delta)
//     → response.output_text.delta
//   content_block_stop on text block
//     → response.output_item.done
//   content_block_start (tool_use)
//     → response.output_item.added (function_call with name)
//   content_block_delta (input_json_delta)
//     → response.function_call_arguments.delta
//   content_block_stop on tool_use
//     → response.output_item.done
//   message_delta + message_stop
//     → response.completed (with usage + status)
//
// State holds: response id/model/created, the open block kind +
// output_index, the content_index counter for the open text item,
// usage accumulators, latest stop_reason.

import type { AnthropicSSEEvent } from "../../stream/anthropicSseParser.js";
import { anthropicStopReasonToResponses } from "../stopReasonMap.js";
import type { StreamTranslator } from "./types.js";
import type {
  ResponsesEventCompleted,
  ResponsesSSEEvent,
} from "./responsesSseTypes.js";

interface State {
  id: string;
  model: string;
  createdAt: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  stopReason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "refusal"
    | null;
  /** Anthropic block index → Responses output_index. */
  blockToOutput: Map<number, number>;
  /**
   * Output_indices that have an `output_item.added` but not yet a
   * matching `output_item.done`. Drained on early termination so the
   * Responses SDK consumer never sees an unclosed item.
   */
  openOutputIndices: Set<number>;
  nextOutputIndex: number;
  finished: boolean;
}

export function makeAnthropicToResponsesStream(
  opts: { now?: () => number } = {},
): StreamTranslator<AnthropicSSEEvent, ResponsesSSEEvent> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const state: State = {
    id: "",
    model: "",
    createdAt: 0,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    stopReason: null,
    blockToOutput: new Map(),
    openOutputIndices: new Set(),
    nextOutputIndex: 0,
    finished: false,
  };

  const drainOpenOutputs = (): ResponsesSSEEvent[] => {
    const out: ResponsesSSEEvent[] = [];
    for (const outputIndex of state.openOutputIndices) {
      out.push({
        type: "response.output_item.done",
        output_index: outputIndex,
      });
    }
    state.openOutputIndices.clear();
    return out;
  };

  const buildCompleted = (): ResponsesEventCompleted => {
    const inputTotal =
      state.inputTokens +
      state.cacheCreationInputTokens +
      state.cacheReadInputTokens;
    const usage = {
      input_tokens: inputTotal,
      output_tokens: state.outputTokens,
      total_tokens: inputTotal + state.outputTokens,
      ...(state.cacheReadInputTokens > 0 && {
        input_tokens_details: { cached_tokens: state.cacheReadInputTokens },
      }),
    };
    let status: "completed" | "incomplete" = "completed";
    let incomplete_details: { reason: string } | null = null;
    if (state.stopReason !== null) {
      const mapped = anthropicStopReasonToResponses(state.stopReason);
      if (mapped === "max_output_tokens" || mapped === "content_filter") {
        status = "incomplete";
        incomplete_details = { reason: mapped };
      }
    }
    return {
      type: "response.completed",
      response: {
        id: state.id,
        status,
        incomplete_details,
        usage,
      },
    };
  };

  return {
    onEvent(event) {
      if (state.finished) return [];
      switch (event.type) {
        case "message_start": {
          state.id = event.message.id;
          state.model = event.message.model;
          state.createdAt = now();
          state.inputTokens = event.message.usage.input_tokens;
          state.cacheCreationInputTokens =
            event.message.usage.cache_creation_input_tokens ?? 0;
          state.cacheReadInputTokens =
            event.message.usage.cache_read_input_tokens ?? 0;
          return [
            {
              type: "response.created",
              response: {
                id: state.id,
                model: state.model,
                created_at: state.createdAt,
              },
            },
          ];
        }
        case "content_block_start": {
          const outputIndex = state.nextOutputIndex++;
          state.blockToOutput.set(event.index, outputIndex);
          state.openOutputIndices.add(outputIndex);
          if (event.content_block.type === "text") {
            return [
              {
                type: "response.output_item.added",
                output_index: outputIndex,
                item: {
                  type: "message",
                  id: `msg_${state.id}_${outputIndex}`,
                  role: "assistant",
                },
              },
              {
                type: "response.content_part.added",
                output_index: outputIndex,
                content_index: 0,
                part: { type: "output_text", text: "" },
              },
            ];
          }
          return [
            {
              type: "response.output_item.added",
              output_index: outputIndex,
              item: {
                type: "function_call",
                id: event.content_block.id,
                call_id: event.content_block.id,
                name: event.content_block.name,
                arguments: "",
              },
            },
          ];
        }
        case "content_block_delta": {
          const outputIndex = state.blockToOutput.get(event.index);
          if (outputIndex === undefined) return [];
          if (event.delta.type === "text_delta") {
            return [
              {
                type: "response.output_text.delta",
                output_index: outputIndex,
                content_index: 0,
                delta: event.delta.text,
              },
            ];
          }
          if (event.delta.type === "input_json_delta") {
            return [
              {
                type: "response.function_call_arguments.delta",
                output_index: outputIndex,
                delta: event.delta.partial_json,
              },
            ];
          }
          return [];
        }
        case "content_block_stop": {
          const outputIndex = state.blockToOutput.get(event.index);
          if (outputIndex === undefined) return [];
          state.openOutputIndices.delete(outputIndex);
          return [
            {
              type: "response.output_item.done",
              output_index: outputIndex,
            },
          ];
        }
        case "message_delta":
          state.stopReason = event.delta.stop_reason;
          state.outputTokens = event.usage.output_tokens;
          return [];
        case "message_stop":
          state.finished = true;
          // Drain any blocks the upstream forgot to close before
          // emitting the terminal completed event.
          return [...drainOpenOutputs(), buildCompleted()];
        case "ping":
          return [];
        case "error":
          return this.onError({
            kind: event.error.type,
            message: event.error.message,
          });
      }
    },
    onEnd() {
      if (state.finished) return [];
      state.finished = true;
      return [...drainOpenOutputs(), buildCompleted()];
    },
    onError(err) {
      if (state.finished) return [];
      state.finished = true;
      return [
        ...drainOpenOutputs(),
        {
          type: "error",
          error: { kind: err.kind, message: err.message },
        },
      ];
    },
  };
}

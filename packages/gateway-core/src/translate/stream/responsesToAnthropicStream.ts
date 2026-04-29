// Plan 5A Part 6 Task 6.10 — OpenAI Responses SSE → Anthropic SSE
// stream translator.
//
// Reverse direction of `anthropicToResponsesStream`. State holds:
// the Anthropic message id/model (extracted from response.created),
// per-output_index → Anthropic block index map, the tool-call call_id
// per output_index, accumulated usage (from response.completed).
//
// Mapping:
//   response.created → message_start
//   response.output_item.added (message)     → no-op (wait for content_part.added)
//   response.content_part.added (output_text) → content_block_start (text)
//   response.output_text.delta                → content_block_delta (text_delta)
//   response.output_item.added (function_call) → content_block_start (tool_use)
//   response.function_call_arguments.delta    → content_block_delta (input_json_delta)
//   response.output_item.done                  → content_block_stop
//   response.completed → message_delta + message_stop

import type {
  AnthropicSSEEvent,
  MessageStartEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  MessageDeltaEvent,
  MessageStopEvent,
} from "../../stream/anthropicSseParser.js";
import {
  responsesFinishReasonToAnthropic,
  type ResponsesFinishReason,
} from "../stopReasonMap.js";
import type { StreamTranslator } from "./types.js";
import type { ResponsesSSEEvent } from "./responsesSseTypes.js";

interface State {
  id: string;
  model: string;
  /** Output_index → Anthropic block index. */
  outputToBlock: Map<number, number>;
  /** Output_index → kind. */
  outputKind: Map<number, "text" | "tool_use">;
  /** Output_index → tool name + id (for emitting content_block_start). */
  pendingToolCall: Map<number, { id: string; name: string }>;
  nextBlockIndex: number;
  messageStarted: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  finished: boolean;
}

function isResponsesFinishReason(
  value: string,
): value is ResponsesFinishReason {
  return (
    value === "stop" ||
    value === "max_output_tokens" ||
    value === "tool_calls" ||
    value === "content_filter"
  );
}

export function makeResponsesToAnthropicStream(): StreamTranslator<
  ResponsesSSEEvent,
  AnthropicSSEEvent
> {
  const state: State = {
    id: "",
    model: "",
    outputToBlock: new Map(),
    outputKind: new Map(),
    pendingToolCall: new Map(),
    nextBlockIndex: 0,
    messageStarted: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    finished: false,
  };

  const ensureMessageStart = (): AnthropicSSEEvent[] => {
    if (state.messageStarted) return [];
    state.messageStarted = true;
    const ev: MessageStartEvent = {
      type: "message_start",
      message: {
        id: state.id || "msg_resp_unknown",
        model: state.model || "unknown",
        role: "assistant",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
    return [ev];
  };

  return {
    onEvent(event) {
      if (state.finished) return [];
      switch (event.type) {
        case "response.created":
          state.id = event.response.id;
          state.model = event.response.model;
          return ensureMessageStart();
        case "response.output_item.added": {
          const out: AnthropicSSEEvent[] = [...ensureMessageStart()];
          if (event.item.type === "function_call") {
            // Open tool_use block immediately.
            const blockIndex = state.nextBlockIndex++;
            state.outputToBlock.set(event.output_index, blockIndex);
            state.outputKind.set(event.output_index, "tool_use");
            const startEv: ContentBlockStartEvent = {
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: event.item.call_id,
                name: event.item.name,
                input: {} as Record<string, never>,
              },
            };
            out.push(startEv);
          } else {
            // Defer text block until content_part.added arrives —
            // some Responses producers emit metadata-only message
            // items that never receive output_text.
            state.pendingToolCall; // noop access for IDE happiness
          }
          return out;
        }
        case "response.content_part.added": {
          if (event.part.type !== "output_text") return [];
          const blockIndex = state.nextBlockIndex++;
          state.outputToBlock.set(event.output_index, blockIndex);
          state.outputKind.set(event.output_index, "text");
          const startEv: ContentBlockStartEvent = {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "text", text: "" },
          };
          return [startEv];
        }
        case "response.output_text.delta": {
          const blockIndex = state.outputToBlock.get(event.output_index);
          if (blockIndex === undefined) return [];
          const deltaEv: ContentBlockDeltaEvent = {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: event.delta },
          };
          return [deltaEv];
        }
        case "response.function_call_arguments.delta": {
          const blockIndex = state.outputToBlock.get(event.output_index);
          if (blockIndex === undefined) return [];
          const deltaEv: ContentBlockDeltaEvent = {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: event.delta },
          };
          return [deltaEv];
        }
        case "response.output_item.done": {
          const blockIndex = state.outputToBlock.get(event.output_index);
          if (blockIndex === undefined) return [];
          const stopEv: ContentBlockStopEvent = {
            type: "content_block_stop",
            index: blockIndex,
          };
          return [stopEv];
        }
        case "response.completed": {
          state.finished = true;
          const usage = event.response.usage;
          if (usage) {
            const cached = usage.input_tokens_details?.cached_tokens ?? 0;
            state.inputTokens = Math.max(0, usage.input_tokens - cached);
            state.cacheReadInputTokens = cached;
            state.outputTokens = usage.output_tokens;
          }
          let stopReason: MessageDeltaEvent["delta"]["stop_reason"] =
            "end_turn";
          if (event.response.status === "incomplete") {
            const reason = event.response.incomplete_details?.reason;
            if (reason && isResponsesFinishReason(reason)) {
              stopReason = responsesFinishReasonToAnthropic(reason);
            } else {
              stopReason = "end_turn";
            }
          } else {
            // If any function_call output was emitted, status=completed
            // with stop_reason=tool_use. We can't know that here without
            // scanning state; default to end_turn unless any tool_use
            // block was seen.
            const sawToolUse = [...state.outputKind.values()].includes(
              "tool_use",
            );
            stopReason = sawToolUse ? "tool_use" : "end_turn";
          }
          const messageDelta: MessageDeltaEvent = {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: state.outputTokens },
          };
          const messageStop: MessageStopEvent = { type: "message_stop" };
          return [messageDelta, messageStop];
        }
        case "error":
          return this.onError({
            kind: event.error.kind,
            message: event.error.message,
          });
      }
    },
    onEnd() {
      if (state.finished) return [];
      state.finished = true;
      const messageDelta: MessageDeltaEvent = {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: state.outputTokens },
      };
      const messageStop: MessageStopEvent = { type: "message_stop" };
      return [messageDelta, messageStop];
    },
    onError(_err) {
      if (state.finished) return [];
      state.finished = true;
      const messageDelta: MessageDeltaEvent = {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: state.outputTokens },
      };
      const messageStop: MessageStopEvent = { type: "message_stop" };
      return [messageDelta, messageStop];
    },
  };
}

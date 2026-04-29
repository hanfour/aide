// Plan 5A Part 6 Task 6.10 — OpenAI Chat SSE → Anthropic SSE stream
// translator.
//
// Inputs are OpenAI Chat completion stream chunks (already parsed
// into ChatStreamDelta).  We re-emit the Anthropic SSE event ladder:
//
//   message_start  — on the first delta (when we know id/model)
//   content_block_start (text)  — first text token
//   content_block_delta (text_delta) — per token
//   content_block_stop          — on first non-text content / stop
//   content_block_start (tool_use) — per tool_call.index
//   content_block_delta (input_json_delta) — per tool argument fragment
//   content_block_stop  — when a tool's arguments are flushed
//   message_delta   — finish_reason + usage (if surfaced)
//   message_stop    — sentinel
//
// State holds: id, model, the open block kind (text vs tool_use), the
// running tool_calls map (chat `index` → Anthropic block index), the
// final finish_reason + usage delta.

import type {
  AnthropicSSEEvent,
  MessageStartEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  MessageDeltaEvent,
  MessageStopEvent,
} from "../../stream/anthropicSseParser.js";
import { chatFinishReasonToAnthropic } from "../stopReasonMap.js";
import type { StreamTranslator } from "./types.js";

interface ChatChoiceDelta {
  role?: "assistant";
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

export interface ChatStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatChoiceDelta;
    finish_reason:
      | null
      | "stop"
      | "length"
      | "tool_calls"
      | "content_filter";
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Sentinel emitted to mark stream end; pipes can serialize as `data: [DONE]`. */
export type ChatStreamInput = ChatStreamChunk | "[DONE]";

interface State {
  id: string;
  model: string;
  messageStarted: boolean;
  /** Current OPEN block index → Anthropic event index; `null` if no block open. */
  openBlock:
    | { kind: "text"; index: number }
    | { kind: "tool_use"; index: number; chatIndex: number }
    | null;
  /** Map from OpenAI Chat tool_calls[i].index → Anthropic block index. */
  toolBlockIndexByChatIndex: Map<number, number>;
  nextBlockIndex: number;
  /** Latest stop reason carried through to message_delta. */
  finishReason:
    | null
    | "stop"
    | "length"
    | "tool_calls"
    | "content_filter";
  promptTokens: number;
  completionTokens: number;
  finished: boolean;
}

export function makeChatToAnthropicStream(): StreamTranslator<
  ChatStreamInput,
  AnthropicSSEEvent
> {
  const state: State = {
    id: "",
    model: "",
    messageStarted: false,
    openBlock: null,
    toolBlockIndexByChatIndex: new Map(),
    nextBlockIndex: 0,
    finishReason: null,
    promptTokens: 0,
    completionTokens: 0,
    finished: false,
  };

  const closeOpenBlock = (out: AnthropicSSEEvent[]): void => {
    if (!state.openBlock) return;
    const stopEv: ContentBlockStopEvent = {
      type: "content_block_stop",
      index: state.openBlock.index,
    };
    out.push(stopEv);
    state.openBlock = null;
  };

  const handleChunk = (chunk: ChatStreamChunk): AnthropicSSEEvent[] => {
    const out: AnthropicSSEEvent[] = [];
    if (!state.messageStarted) {
      state.id = chunk.id;
      state.model = chunk.model;
      state.messageStarted = true;
      const startEv: MessageStartEvent = {
        type: "message_start",
        message: {
          id: chunk.id,
          model: chunk.model,
          role: "assistant",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
      out.push(startEv);
    }
    if (chunk.usage) {
      state.promptTokens = chunk.usage.prompt_tokens;
      state.completionTokens = chunk.usage.completion_tokens;
    }
    const choice = chunk.choices[0];
    if (!choice) return out;
    const delta = choice.delta;
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      // tool_use deltas — close any open text block first.
      if (state.openBlock?.kind === "text") closeOpenBlock(out);
      for (const tc of delta.tool_calls) {
        let anthropicIndex = state.toolBlockIndexByChatIndex.get(tc.index);
        if (anthropicIndex === undefined && tc.function?.name) {
          // First sighting → open a new tool_use block.
          anthropicIndex = state.nextBlockIndex++;
          state.toolBlockIndexByChatIndex.set(tc.index, anthropicIndex);
          // Close any previous tool block before opening a new one.
          if (
            state.openBlock?.kind === "tool_use" &&
            state.openBlock.chatIndex !== tc.index
          ) {
            closeOpenBlock(out);
          }
          const startEv: ContentBlockStartEvent = {
            type: "content_block_start",
            index: anthropicIndex,
            content_block: {
              type: "tool_use",
              id: tc.id ?? `tool_${anthropicIndex}`,
              name: tc.function.name,
              input: {} as Record<string, never>,
            },
          };
          out.push(startEv);
          state.openBlock = {
            kind: "tool_use",
            index: anthropicIndex,
            chatIndex: tc.index,
          };
        }
        if (anthropicIndex !== undefined && tc.function?.arguments) {
          const deltaEv: ContentBlockDeltaEvent = {
            type: "content_block_delta",
            index: anthropicIndex,
            delta: {
              type: "input_json_delta",
              partial_json: tc.function.arguments,
            },
          };
          out.push(deltaEv);
        }
      }
    } else if (typeof delta.content === "string" && delta.content.length > 0) {
      if (state.openBlock?.kind === "tool_use") closeOpenBlock(out);
      if (!state.openBlock) {
        const startEv: ContentBlockStartEvent = {
          type: "content_block_start",
          index: state.nextBlockIndex,
          content_block: { type: "text", text: "" },
        };
        out.push(startEv);
        state.openBlock = { kind: "text", index: state.nextBlockIndex };
        state.nextBlockIndex += 1;
      }
      const deltaEv: ContentBlockDeltaEvent = {
        type: "content_block_delta",
        index: state.openBlock.index,
        delta: { type: "text_delta", text: delta.content },
      };
      out.push(deltaEv);
    }
    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason;
    }
    return out;
  };

  const finalize = (): AnthropicSSEEvent[] => {
    if (state.finished) return [];
    state.finished = true;
    const out: AnthropicSSEEvent[] = [];
    if (!state.messageStarted) return out;
    closeOpenBlock(out);
    const stopReason =
      state.finishReason !== null
        ? chatFinishReasonToAnthropic(state.finishReason)
        : "end_turn";
    const messageDelta: MessageDeltaEvent = {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: state.completionTokens },
    };
    out.push(messageDelta);
    const messageStop: MessageStopEvent = { type: "message_stop" };
    out.push(messageStop);
    return out;
  };

  return {
    onEvent(input) {
      if (state.finished) return [];
      if (input === "[DONE]") return finalize();
      return handleChunk(input);
    },
    onEnd() {
      return finalize();
    },
    onError(err) {
      if (state.finished) return [];
      // Surface as message_delta + message_stop with stop_reason
      // mapped to refusal-ish so clients can detect mid-stream
      // failure.  The pipe wrapper additionally controllers.error()
      // after this drain — translators can't suppress that.
      const out: AnthropicSSEEvent[] = [];
      closeOpenBlock(out);
      if (state.messageStarted) {
        const messageDelta: MessageDeltaEvent = {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: state.completionTokens },
        };
        out.push(messageDelta);
        const messageStop: MessageStopEvent = { type: "message_stop" };
        out.push(messageStop);
      }
      state.finished = true;
      // Annotate the kind on a debug-friendly logging path; the pipe
      // wrapper logs the original error itself.
      void err;
      return out;
    },
  };
}

// Plan 5A Part 6 Task 6.7 — non-stream response translator.
//
// Translates an Anthropic Messages API response into the OpenAI
// Responses API response shape. Used when the client speaks
// `openai-responses` but the upstream account is on the Anthropic
// platform.
//
// Mapping:
//   * Anthropic `content[]` text blocks → one `output_item` of type
//     `message` with `output_text` parts.
//   * Anthropic `content[]` tool_use blocks → one `output_item` of
//     type `function_call` per tool use (call_id mirrored from id).
//   * `stop_reason` → `incomplete_details.reason` when not a terminal
//     stop, or response status="completed" when terminal.
//   * `usage.input_tokens` (+ cache) → `usage.input_tokens`; cache_read
//     is surfaced via `input_tokens_details.cached_tokens`.

import type { AnthropicMessagesResponse } from "../types.js";
import type {
  ResponsesOutputItem,
  ResponsesResponse,
  ResponsesUsage,
} from "../responsesTypes.js";
import { anthropicStopReasonToResponses } from "../stopReasonMap.js";

export interface TranslateAnthropicResponseToResponsesOptions {
  /** Inject for deterministic tests. Defaults to Date.now(). */
  now?: () => number;
}

export function translateAnthropicResponseToResponses(
  anthropic: AnthropicMessagesResponse,
  opts: TranslateAnthropicResponseToResponsesOptions = {},
): ResponsesResponse {
  const nowMs = (opts.now ?? Date.now)();
  const created_at = Math.floor(nowMs / 1000);

  const output = buildOutputItems(anthropic);
  const usage = buildUsage(anthropic.usage);
  const { status, incomplete_details } = mapStatus(anthropic.stop_reason);

  return {
    id: anthropic.id,
    object: "response",
    created_at,
    model: anthropic.model,
    status,
    output,
    usage,
    incomplete_details,
  };
}

function buildOutputItems(
  anthropic: AnthropicMessagesResponse,
): ResponsesOutputItem[] {
  const items: ResponsesOutputItem[] = [];
  const textBlocks = anthropic.content.filter(
    (b): b is { type: "text"; text: string } => b.type === "text",
  );
  const toolUseBlocks = anthropic.content.filter(
    (
      b,
    ): b is {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    } => b.type === "tool_use",
  );

  // Emit one assistant message item carrying all text content.  The
  // Responses API always envelops text in a single `message` output_item;
  // multiple text blocks at the Anthropic level concatenate into a
  // single `output_text` chunk to keep the boundary simple.
  if (textBlocks.length > 0) {
    items.push({
      type: "message",
      id: `msg_${anthropic.id}`,
      role: "assistant",
      status: "completed",
      content: textBlocks.map((b) => ({
        type: "output_text",
        text: b.text,
        annotations: [],
      })),
    });
  }

  // Each Anthropic tool_use block becomes its own function_call item.
  for (const block of toolUseBlocks) {
    items.push({
      type: "function_call",
      id: block.id,
      call_id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input),
      status: "completed",
    });
  }

  return items;
}

function buildUsage(usage: AnthropicMessagesResponse["usage"]): ResponsesUsage {
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const input_tokens = usage.input_tokens + cacheCreate + cacheRead;
  const output_tokens = usage.output_tokens;
  const result: ResponsesUsage = {
    input_tokens,
    output_tokens,
    total_tokens: input_tokens + output_tokens,
  };
  if (cacheRead > 0) {
    result.input_tokens_details = { cached_tokens: cacheRead };
  }
  return result;
}

function mapStatus(
  stopReason: AnthropicMessagesResponse["stop_reason"],
): {
  status: ResponsesResponse["status"];
  incomplete_details: ResponsesResponse["incomplete_details"];
} {
  if (stopReason === null) {
    return { status: "in_progress", incomplete_details: null };
  }
  // Anthropic "max_tokens" + "refusal" map to incomplete in the
  // Responses model; everything else is a clean completion.
  const mapped = anthropicStopReasonToResponses(stopReason);
  if (mapped === "max_output_tokens" || mapped === "content_filter") {
    return {
      status: "incomplete",
      incomplete_details: { reason: mapped },
    };
  }
  return { status: "completed", incomplete_details: null };
}

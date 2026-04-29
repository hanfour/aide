// Plan 5A Part 6 Task 6.7 — non-stream response translator.
//
// Translates an OpenAI Responses API response into the Anthropic
// Messages API response shape.  Used when the client speaks
// `anthropic` but the upstream account is on an OpenAI account using
// the Responses-format endpoint (Codex CLI, ChatGPT subscription
// pool).
//
// Mapping:
//   * Responses `output_item[type=message].content[type=output_text]`
//     → Anthropic `text` content blocks.
//   * Responses `output_item[type=function_call]` → Anthropic
//     `tool_use` blocks (call_id mirrors id; arguments JSON-parsed).
//   * `status=completed` → stop_reason `end_turn` (default), unless
//     `incomplete_details.reason` says otherwise.
//   * `usage.input_tokens_details.cached_tokens` → Anthropic
//     `cache_read_input_tokens` so the cost path keeps cache-tier
//     accounting.

import type { AnthropicMessagesResponse, AnthropicUsage } from "../types.js";
import type { ResponsesResponse, ResponsesUsage } from "../responsesTypes.js";
import {
  responsesFinishReasonToAnthropic,
  type ResponsesFinishReason,
} from "../stopReasonMap.js";

export function translateResponsesResponseToAnthropic(
  resp: ResponsesResponse,
): AnthropicMessagesResponse {
  const content = buildContent(resp);
  const stop_reason = mapStopReason(resp);

  return {
    id: resp.id,
    type: "message",
    role: "assistant",
    content,
    model: resp.model,
    stop_reason,
    stop_sequence: null,
    usage: buildUsage(resp.usage),
  };
}

function buildContent(
  resp: ResponsesResponse,
): AnthropicMessagesResponse["content"] {
  // We preserve the upstream `output[]` order rather than re-sorting
  // text-before-tool_use to match Anthropic's emission convention. The
  // SDK accepts either ordering on the response side, and preserving
  // upstream order keeps the round-trip lossless when an upstream
  // emits text after tool_use (rare but legal).
  const blocks: AnthropicMessagesResponse["content"] = [];
  for (const item of resp.output) {
    if (item.type === "message") {
      const text = item.content
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("");
      if (text.length > 0) {
        blocks.push({ type: "text", text });
      }
    } else if (item.type === "function_call") {
      blocks.push({
        type: "tool_use",
        id: item.id,
        name: item.name,
        input: parseToolArguments(item.arguments),
      });
    }
  }
  return blocks;
}

function mapStopReason(
  resp: ResponsesResponse,
): AnthropicMessagesResponse["stop_reason"] {
  if (resp.status === "in_progress") return null;

  // If a function_call appears in output, the run completed via tool
  // handoff regardless of `status` — surface as `tool_use`.
  if (resp.output.some((item) => item.type === "function_call")) {
    return "tool_use";
  }

  if (resp.status === "incomplete" && resp.incomplete_details) {
    const reason = resp.incomplete_details.reason;
    if (isResponsesFinishReason(reason)) {
      return responsesFinishReasonToAnthropic(reason);
    }
  }
  // Default for completed runs without tool use.
  return "end_turn";
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

/**
 * Parse function_call arguments JSON, surfacing malformed payloads
 * with a `_malformed: true` discriminator so downstream tool handlers
 * can pattern-match on the wrapper instead of guessing whether `_raw`
 * meant "couldn't parse" or "wasn't an object".
 */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { _malformed: true, _raw: parsed };
  } catch {
    return { _malformed: true, _raw: raw };
  }
}

function buildUsage(usage?: ResponsesUsage): AnthropicUsage {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  // Responses `input_tokens` is the GROSS count (including cached);
  // Anthropic counts non-cached as `input_tokens` and surfaces cached
  // separately, so subtract here to keep the billing math consistent.
  const nonCached = Math.max(0, usage.input_tokens - cached);
  const result: AnthropicUsage = {
    input_tokens: nonCached,
    output_tokens: usage.output_tokens,
  };
  if (cached > 0) {
    result.cache_read_input_tokens = cached;
  }
  return result;
}

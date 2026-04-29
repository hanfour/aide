// Plan 5A Part 6 Task 6.7 — non-stream response translator.
//
// Translates an OpenAI Chat Completions response into the Anthropic
// Messages API response shape.  Used when the client speaks
// `anthropic` but the upstream account is on an OpenAI account that
// emits Chat-format responses.
//
// Mapping:
//   * `choices[0].message.content` (string|null) → Anthropic text content
//     block (omitted when both content and tool_calls are missing).
//   * `choices[0].message.tool_calls[]` → Anthropic `tool_use` blocks
//     (`function.arguments` JSON-parsed back to an object).
//   * `finish_reason` → Anthropic stop_reason via stopReasonMap.
//   * `usage.{prompt,completion}_tokens` → `usage.{input,output}_tokens`.
//
// Multiple choices aren't supported on the Anthropic side, so we take
// `choices[0]` only — matches OpenAI's de facto single-choice usage.

import type {
  AnthropicMessagesResponse,
  AnthropicUsage,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionMessage,
} from "../types.js";
import { chatFinishReasonToAnthropic } from "../stopReasonMap.js";

export function translateChatResponseToAnthropic(
  chat: OpenAIChatCompletionResponse,
): AnthropicMessagesResponse {
  const choice = chat.choices[0];
  if (!choice) {
    // Empty choices is invalid per OpenAI contract, but emit a minimal
    // shell so callers don't NPE on a downstream `.content` read.
    return {
      id: chat.id,
      type: "message",
      role: "assistant",
      content: [],
      model: chat.model,
      stop_reason: null,
      stop_sequence: null,
      usage: buildUsage(chat.usage),
    };
  }

  const content = buildContent(choice.message);
  const stop_reason = choice.finish_reason
    ? chatFinishReasonToAnthropic(choice.finish_reason)
    : null;

  return {
    id: chat.id,
    type: "message",
    role: "assistant",
    content,
    model: chat.model,
    stop_reason,
    stop_sequence: null,
    usage: buildUsage(chat.usage),
  };
}

function buildContent(
  message: OpenAIChatCompletionMessage,
): AnthropicMessagesResponse["content"] {
  const blocks: AnthropicMessagesResponse["content"] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    blocks.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments),
    });
  }
  return blocks;
}

function buildUsage(
  usage: OpenAIChatCompletionResponse["usage"] | undefined,
): AnthropicUsage {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
  };
}

/**
 * Parse tool-call function arguments JSON, surfacing malformed payloads
 * with a `_malformed: true` discriminator so downstream tool handlers can
 * decide whether to skip / retry / surface the error rather than treat
 * the wrapper as a legitimate call.
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

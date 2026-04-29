import type {
  AnthropicMessagesResponse,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionChoice,
  OpenAIChatCompletionMessage,
  OpenAIToolCallResult,
} from "./types.js";

type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

// Note: "refusal" was added to AnthropicMessagesResponse.stop_reason in
// 5A (Plan 5A Part 6 Task 6.7); the switch below now folds it into the
// canonical OpenAI `content_filter` value.

/**
 * Translate a complete (non-streaming) Anthropic Messages response into the
 * OpenAI chat/completions response shape. Pure function.
 *
 * @param anthropic - The Anthropic response object.
 * @param opts.now  - Injected clock (milliseconds). Defaults to Date.now().
 *                    Allows deterministic tests.
 */
export function translateAnthropicToOpenAI(
  anthropic: AnthropicMessagesResponse,
  opts: { now?: () => number } = {},
): OpenAIChatCompletionResponse {
  const nowMs = (opts.now ?? Date.now)();
  const created = Math.floor(nowMs / 1000);

  const message = buildMessage(anthropic);
  const finishReason = mapStopReason(anthropic.stop_reason);

  const choice: OpenAIChatCompletionChoice = {
    index: 0,
    message,
    finish_reason: finishReason,
  };

  const usage = buildUsage(anthropic.usage);

  return {
    id: anthropic.id,
    object: "chat.completion",
    created,
    model: anthropic.model,
    choices: [choice],
    usage,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMessage(
  anthropic: AnthropicMessagesResponse,
): OpenAIChatCompletionMessage {
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

  const content =
    textBlocks.length > 0 ? textBlocks.map((b) => b.text).join("") : null;

  const message: OpenAIChatCompletionMessage = {
    role: "assistant",
    content,
  };

  if (toolUseBlocks.length > 0) {
    message.tool_calls = toolUseBlocks.map(
      (b): OpenAIToolCallResult => ({
        id: b.id,
        type: "function",
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input),
        },
      }),
    );
  }

  return message;
}

function mapStopReason(
  stopReason: AnthropicMessagesResponse["stop_reason"],
): FinishReason {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

function buildUsage(usage: AnthropicMessagesResponse["usage"]): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const prompt_tokens =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  const completion_tokens = usage.output_tokens;
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

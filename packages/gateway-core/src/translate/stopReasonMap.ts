// Plan 5A §10.4 — bidirectional stop-reason mapping across the three
// formats this gateway translates.  The Anthropic stop-reason taxonomy
// is the canonical "central" set; Chat + Responses each have a smaller
// set that maps from Anthropic via fixed projections.
//
// | Anthropic       | OpenAI Chat         | OpenAI Responses     |
// |-----------------|---------------------|----------------------|
// | end_turn        | stop                | stop                 |
// | max_tokens      | length              | max_output_tokens    |
// | tool_use        | tool_calls          | tool_calls           |
// | stop_sequence   | stop                | stop                 |
// | refusal         | content_filter      | content_filter       |
//
// Reverse mappings collapse the lossy projection back to a "best-fit"
// Anthropic value so a round-trip Anthropic→Chat→Anthropic preserves
// most semantics.  Pivot translation (chat ↔ responses) chains the two
// reverses through Anthropic without ever observing the lossy step.

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence"
  | "refusal";

export type ChatFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter";

export type ResponsesFinishReason =
  | "stop"
  | "max_output_tokens"
  | "tool_calls"
  | "content_filter";

export function anthropicStopReasonToChat(
  reason: AnthropicStopReason,
): ChatFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
  }
}

export function anthropicStopReasonToResponses(
  reason: AnthropicStopReason,
): ResponsesFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "max_output_tokens";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
  }
}

export function chatFinishReasonToAnthropic(
  reason: ChatFinishReason,
): AnthropicStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
  }
}

export function responsesFinishReasonToAnthropic(
  reason: ResponsesFinishReason,
): AnthropicStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "max_output_tokens":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
  }
}

/** Pivot helper: chat → anthropic → responses. */
export function chatFinishReasonToResponses(
  reason: ChatFinishReason,
): ResponsesFinishReason {
  return anthropicStopReasonToResponses(chatFinishReasonToAnthropic(reason));
}

/** Pivot helper: responses → anthropic → chat. */
export function responsesFinishReasonToChat(
  reason: ResponsesFinishReason,
): ChatFinishReason {
  return anthropicStopReasonToChat(
    responsesFinishReasonToAnthropic(reason),
  );
}

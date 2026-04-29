import type { OpenAIChatRequest } from "./types.js";
import { translateOpenAIToAnthropic } from "./openaiToAnthropic.js";
import { translateAnthropicToResponses } from "./anthropicToResponses.js";
import type { ResponsesRequest } from "./responsesTypes.js";

// Plan 5A §10.6 — pivot composition.  4A already has chat ↔ anthropic
// (`openaiToAnthropic.ts`).  Rather than build a fourth pair of
// translators for chat ↔ responses, we compose the existing chat →
// anthropic with the new anthropic → responses (both pure functions).
// The pivot adds < 1ms per request (just the intermediate object) and
// keeps the translator surface to 4 modules instead of 8.

export function translateChatToResponses(
  body: OpenAIChatRequest,
): ResponsesRequest {
  return translateAnthropicToResponses(translateOpenAIToAnthropic(body));
}

// Plan 5A Part 6 Task 6.7 — non-stream response translator (pivot).
//
// Composes `responses → anthropic` then `anthropic → chat` (the 4A
// `translateAnthropicToOpenAI`). Used when the client speaks Chat but
// the upstream is OpenAI Responses (e.g. ChatGPT subscription accounts
// via the Responses API surface).

import type { OpenAIChatCompletionResponse } from "../types.js";
import type { ResponsesResponse } from "../responsesTypes.js";
import { translateResponsesResponseToAnthropic } from "./responsesToAnthropic.js";
import { translateAnthropicToOpenAI } from "../anthropicToOpenai.js";

export function translateResponsesResponseToChat(
  resp: ResponsesResponse,
  opts: { now?: () => number } = {},
): OpenAIChatCompletionResponse {
  return translateAnthropicToOpenAI(
    translateResponsesResponseToAnthropic(resp),
    opts,
  );
}

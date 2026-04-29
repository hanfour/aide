// Plan 5A Part 6 Task 6.7 — non-stream response translator (pivot).
//
// Composes `chat → anthropic` then `anthropic → responses`. Saves an
// independent implementation; the pivot cost is two object allocations
// per response (negligible). Direction key is `openai-responses->openai-chat`
// in the dispatch table — i.e., client speaks Chat, upstream returned
// Responses-format. The translator name reads in the data-flow
// direction (Chat upstream resp → Responses client resp) which is the
// inverse of the request-side dispatch key, matching design §10.7.

import type { OpenAIChatCompletionResponse } from "../types.js";
import type { ResponsesResponse } from "../responsesTypes.js";
import { translateChatResponseToAnthropic } from "./chatToAnthropic.js";
import {
  translateAnthropicResponseToResponses,
  type TranslateAnthropicResponseToResponsesOptions,
} from "./anthropicToResponses.js";

export function translateChatResponseToResponses(
  chat: OpenAIChatCompletionResponse,
  opts: TranslateAnthropicResponseToResponsesOptions = {},
): ResponsesResponse {
  return translateAnthropicResponseToResponses(
    translateChatResponseToAnthropic(chat),
    opts,
  );
}

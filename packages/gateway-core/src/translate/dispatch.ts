import type {
  AnthropicMessagesRequest,
  OpenAIChatRequest,
} from "./types.js";
import type { ResponsesRequest } from "./responsesTypes.js";
import { translateOpenAIToAnthropic } from "./openaiToAnthropic.js";
import { translateAnthropicToChat } from "./anthropicToChat.js";
import { translateAnthropicToResponses } from "./anthropicToResponses.js";
import { translateResponsesToAnthropic } from "./responsesToAnthropic.js";
import { translateChatToResponses } from "./chatToResponses.js";
import { translateResponsesToChat } from "./responsesToChat.js";

// Plan 5A §10.7 — direction lookup table for REQUEST body translation.
// Route handlers (Part 9) compose a `${clientFormat}->${upstreamFormat}`
// key from the inbound URL space + the resolved group's upstream
// account capabilities, then dispatch through this table.  Passthrough
// directions return the body verbatim — the gateway forwards it
// unchanged when the client and upstream speak the same format.
//
// Response-side translation lives in a parallel table that PR 6b will
// add; stream translators land in PR 6c.

export type Format = "anthropic" | "openai-chat" | "openai-responses";
export type Direction = `${Format}->${Format}`;

/**
 * Discriminated body type — translators are typed against their
 * input/output shapes, but the dispatch table erases that to allow a
 * single Record<Direction, …> indexed by string.  Callers cast the
 * result to the appropriate target shape based on the lookup key (the
 * route handler always knows the upstream format).
 */
export type AnyRequestBody =
  | AnthropicMessagesRequest
  | OpenAIChatRequest
  | ResponsesRequest;

export type RequestTranslator = (body: AnyRequestBody) => AnyRequestBody;

const PASSTHROUGH: RequestTranslator = (body) => body;

export const requestTranslators: Record<Direction, RequestTranslator> = {
  "anthropic->anthropic": PASSTHROUGH,
  "anthropic->openai-chat": (body) =>
    translateAnthropicToChat(body as AnthropicMessagesRequest),
  "anthropic->openai-responses": (body) =>
    translateAnthropicToResponses(body as AnthropicMessagesRequest),
  "openai-chat->anthropic": (body) =>
    translateOpenAIToAnthropic(body as OpenAIChatRequest),
  "openai-chat->openai-chat": PASSTHROUGH,
  "openai-chat->openai-responses": (body) =>
    translateChatToResponses(body as OpenAIChatRequest),
  "openai-responses->anthropic": (body) =>
    translateResponsesToAnthropic(body as ResponsesRequest),
  "openai-responses->openai-chat": (body) =>
    translateResponsesToChat(body as ResponsesRequest),
  "openai-responses->openai-responses": PASSTHROUGH,
};

/**
 * Apply the request translator for `${client}->${upstream}`.  Returns the
 * body verbatim for passthrough directions.  Throws if the direction
 * key is unknown — the route handler is expected to construct keys from
 * the validated `Format` union, so an unknown direction signals a
 * programming error rather than client input.
 */
export function translateRequest(
  client: Format,
  upstream: Format,
  body: AnyRequestBody,
): AnyRequestBody {
  const direction: Direction = `${client}->${upstream}`;
  const translator = requestTranslators[direction];
  if (!translator) {
    throw new Error(`unknown_translate_direction: ${direction}`);
  }
  return translator(body);
}

import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  OpenAIChatRequest,
  OpenAIChatCompletionResponse,
} from "./types.js";
import type { ResponsesRequest, ResponsesResponse } from "./responsesTypes.js";
import { translateOpenAIToAnthropic } from "./openaiToAnthropic.js";
import { translateAnthropicToOpenAI } from "./anthropicToOpenai.js";
import { translateAnthropicToChat } from "./anthropicToChat.js";
import { translateAnthropicToResponses } from "./anthropicToResponses.js";
import { translateResponsesToAnthropic } from "./responsesToAnthropic.js";
import { translateChatToResponses } from "./chatToResponses.js";
import { translateResponsesToChat } from "./responsesToChat.js";
import { translateAnthropicResponseToResponses } from "./response/anthropicToResponses.js";
import { translateChatResponseToAnthropic } from "./response/chatToAnthropic.js";
import { translateResponsesResponseToAnthropic } from "./response/responsesToAnthropic.js";
import { translateChatResponseToResponses } from "./response/chatToResponses.js";
import { translateResponsesResponseToChat } from "./response/responsesToChat.js";

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

// ---------------------------------------------------------------------------
// Plan 5A §10.7 — direction lookup table for RESPONSE body translation
// (Plan 5A Part 6 Task 6.8).
//
// Direction keys mirror the request table: `${clientFormat}->${upstreamFormat}`.
// A response translator transforms an UPSTREAM response into the
// CLIENT-facing format — so the data-flow arrow is the inverse of the
// key.  This keeps route-handler code symmetric: the same `direction`
// drives request translation on the way in and response translation on
// the way out.
// ---------------------------------------------------------------------------

export type AnyResponseBody =
  | AnthropicMessagesResponse
  | OpenAIChatCompletionResponse
  | ResponsesResponse;

export interface ResponseTranslateOptions {
  /** Inject for deterministic tests (used by Anthropic→Chat/Responses). */
  now?: () => number;
}

export type ResponseTranslator = (
  body: AnyResponseBody,
  opts?: ResponseTranslateOptions,
) => AnyResponseBody;

const RESPONSE_PASSTHROUGH: ResponseTranslator = (body) => body;

export const responseTranslators: Record<Direction, ResponseTranslator> = {
  // Same-format passthrough.
  "anthropic->anthropic": RESPONSE_PASSTHROUGH,
  "openai-chat->openai-chat": RESPONSE_PASSTHROUGH,
  "openai-responses->openai-responses": RESPONSE_PASSTHROUGH,

  // Client = Anthropic; upstream returned in OpenAI shapes → translate
  // into Anthropic.
  "anthropic->openai-chat": (body) =>
    translateChatResponseToAnthropic(body as OpenAIChatCompletionResponse),
  "anthropic->openai-responses": (body) =>
    translateResponsesResponseToAnthropic(body as ResponsesResponse),

  // Client = OpenAI Chat; upstream returned in other shapes → translate
  // into Chat.  4A's translateAnthropicToOpenAI handles the
  // anthropic-upstream case; the pivot handles responses-upstream.
  "openai-chat->anthropic": (body, opts) =>
    translateAnthropicToOpenAI(body as AnthropicMessagesResponse, opts),
  "openai-chat->openai-responses": (body, opts) =>
    translateResponsesResponseToChat(body as ResponsesResponse, opts),

  // Client = OpenAI Responses; upstream returned in other shapes →
  // translate into Responses.
  "openai-responses->anthropic": (body, opts) =>
    translateAnthropicResponseToResponses(
      body as AnthropicMessagesResponse,
      opts,
    ),
  "openai-responses->openai-chat": (body, opts) =>
    translateChatResponseToResponses(
      body as OpenAIChatCompletionResponse,
      opts,
    ),
};

/**
 * Apply the response translator for `${client}->${upstream}`.  Returns
 * the body verbatim for same-format passthrough directions.  Throws
 * on an unknown direction key — see `translateRequest` for rationale.
 */
export function translateResponse(
  client: Format,
  upstream: Format,
  body: AnyResponseBody,
  opts: ResponseTranslateOptions = {},
): AnyResponseBody {
  const direction: Direction = `${client}->${upstream}`;
  const translator = responseTranslators[direction];
  if (!translator) {
    throw new Error(`unknown_translate_direction: ${direction}`);
  }
  return translator(body, opts);
}

// ---------------------------------------------------------------------------
// Plan 5A §10.7 — STREAM translator factory dispatch (Plan 5A Part 6
// Task 6.11).
//
// Direction keys mirror request + response tables: `${client}->${upstream}`.
// Each entry returns a fresh `StreamTranslator` state machine. Pivots
// compose two translators internally; same-format directions return a
// passthrough state machine that simply re-emits whatever it receives
// (typed as `unknown` since we never inspect upstream events on the
// passthrough path — the route handler shovels bytes through directly).
// ---------------------------------------------------------------------------

import type { StreamTranslator } from "./stream/types.js";
import type { AnthropicSSEEvent } from "../stream/anthropicSseParser.js";
import type { ChatStreamInput } from "./stream/chatToAnthropicStream.js";
import type { ChatStreamOutput } from "./stream/responsesToChatStream.js";
import type { ResponsesSSEEvent } from "./stream/responsesSseTypes.js";
import { makeAnthropicToChatStream } from "./stream/anthropicToChatStream.js";
import { makeChatToAnthropicStream } from "./stream/chatToAnthropicStream.js";
import { makeAnthropicToResponsesStream } from "./stream/anthropicToResponsesStream.js";
import { makeResponsesToAnthropicStream } from "./stream/responsesToAnthropicStream.js";
import { makeChatToResponsesStream } from "./stream/chatToResponsesStream.js";
import { makeResponsesToChatStream } from "./stream/responsesToChatStream.js";

export interface StreamTranslateOptions {
  /** Inject for deterministic tests (used by Anthropic→Chat/Responses). */
  now?: () => number;
}

/** Erased translator type for the dispatch table. */
export type AnyStreamTranslator = StreamTranslator<unknown, unknown>;

/**
 * Same-format passthrough — emits whatever it receives. Used by route
 * handlers that don't need translation (client + upstream agree on
 * format) but still want a uniform translator interface in the pipe.
 */
function makePassthroughStream<T>(): StreamTranslator<T, T> {
  return {
    onEvent: (e) => [e],
    onEnd: () => [],
    onError: () => [],
  };
}

export const streamTranslators: Record<
  Direction,
  (opts?: StreamTranslateOptions) => AnyStreamTranslator
> = {
  "anthropic->anthropic": () =>
    makePassthroughStream<AnthropicSSEEvent>() as AnyStreamTranslator,
  "openai-chat->openai-chat": () =>
    makePassthroughStream<ChatStreamInput>() as AnyStreamTranslator,
  "openai-responses->openai-responses": () =>
    makePassthroughStream<ResponsesSSEEvent>() as AnyStreamTranslator,

  "anthropic->openai-chat": () =>
    makeChatToAnthropicStream() as unknown as AnyStreamTranslator,
  "anthropic->openai-responses": () =>
    makeResponsesToAnthropicStream() as unknown as AnyStreamTranslator,

  "openai-chat->anthropic": (opts) =>
    makeAnthropicToChatStream(opts) as unknown as AnyStreamTranslator,
  "openai-chat->openai-responses": (opts) =>
    makeResponsesToChatStream(opts) as unknown as AnyStreamTranslator,

  "openai-responses->anthropic": (opts) =>
    makeAnthropicToResponsesStream(opts) as unknown as AnyStreamTranslator,
  "openai-responses->openai-chat": (opts) =>
    makeChatToResponsesStream(opts) as unknown as AnyStreamTranslator,
};

/**
 * Constructs a fresh `StreamTranslator` state machine for the given
 * `${client}->${upstream}` direction. Throws on an unknown direction
 * key — see `translateRequest` for rationale.
 */
export function makeStreamTranslator(
  client: Format,
  upstream: Format,
  opts: StreamTranslateOptions = {},
): AnyStreamTranslator {
  const direction: Direction = `${client}->${upstream}`;
  const factory = streamTranslators[direction];
  if (!factory) {
    throw new Error(`unknown_translate_direction: ${direction}`);
  }
  return factory(opts);
}

// Re-export for callers that don't want to dig through `stream/*`.
export type {
  StreamTranslator,
  StreamTranslatorFactory,
} from "./stream/types.js";
export type { ChatStreamOutput };

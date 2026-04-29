// Plan 5A Part 6 Task 6.10 — pivot stream translator.
//
// Composes `responses → anthropic` then `anthropic → chat`.  Mirrors
// `chatToResponsesStream`, just with the stages reversed.

import type { StreamTranslator } from "./types.js";
import { makeResponsesToAnthropicStream } from "./responsesToAnthropicStream.js";
import { makeAnthropicToChatStream } from "./anthropicToChatStream.js";
import type { ResponsesSSEEvent } from "./responsesSseTypes.js";
import type { OpenAIStreamChunk } from "../anthropicToOpenaiStream.js";

export type ChatStreamOutput = OpenAIStreamChunk | "[DONE]";

export function makeResponsesToChatStream(
  opts: { now?: () => number } = {},
): StreamTranslator<ResponsesSSEEvent, ChatStreamOutput> {
  const ra = makeResponsesToAnthropicStream();
  const ac = makeAnthropicToChatStream(opts);

  return {
    onEvent(event) {
      const out: ChatStreamOutput[] = [];
      for (const a of ra.onEvent(event)) {
        for (const c of ac.onEvent(a)) {
          out.push(c);
        }
      }
      return out;
    },
    onEnd() {
      const out: ChatStreamOutput[] = [];
      for (const a of ra.onEnd()) {
        for (const c of ac.onEvent(a)) {
          out.push(c);
        }
      }
      for (const c of ac.onEnd()) {
        out.push(c);
      }
      return out;
    },
    onError(err) {
      ra.onError(err);
      return ac.onError(err);
    },
  };
}

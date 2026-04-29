// Plan 5A Part 6 Task 6.10 — pivot stream translator.
//
// Composes `chat → anthropic` then `anthropic → responses`, per
// design §10.6.  The state machine flatMap'd through is the
// straightforward implementation: feed the Chat input through
// chatToAnthropic, then feed each emitted Anthropic event through
// anthropicToResponses. End-of-stream drain mirrors the chain.

import type { StreamTranslator } from "./types.js";
import type { ChatStreamInput } from "./chatToAnthropicStream.js";
import { makeChatToAnthropicStream } from "./chatToAnthropicStream.js";
import { makeAnthropicToResponsesStream } from "./anthropicToResponsesStream.js";
import type { ResponsesSSEEvent } from "./responsesSseTypes.js";

export function makeChatToResponsesStream(
  opts: { now?: () => number } = {},
): StreamTranslator<ChatStreamInput, ResponsesSSEEvent> {
  const ca = makeChatToAnthropicStream();
  const ar = makeAnthropicToResponsesStream(opts);

  return {
    onEvent(event) {
      const out: ResponsesSSEEvent[] = [];
      for (const a of ca.onEvent(event)) {
        for (const r of ar.onEvent(a)) {
          out.push(r);
        }
      }
      return out;
    },
    onEnd() {
      const out: ResponsesSSEEvent[] = [];
      // Drain the first stage; each event flows into the second stage.
      for (const a of ca.onEnd()) {
        for (const r of ar.onEvent(a)) {
          out.push(r);
        }
      }
      // Then drain the second stage's tail.
      for (const r of ar.onEnd()) {
        out.push(r);
      }
      return out;
    },
    onError(err) {
      // Mirror onEnd's flat-map pattern: stage 1's onError tail flows
      // through stage 2's onEvent, then stage 2's own onError drains
      // its tail.  Without this the consumer sees a different
      // terminator on errors than on clean end-of-stream (stage 1's
      // message_delta + message_stop would be silently dropped).
      const out: ResponsesSSEEvent[] = [];
      for (const a of ca.onError(err)) {
        for (const r of ar.onEvent(a)) {
          out.push(r);
        }
      }
      for (const r of ar.onError(err)) {
        out.push(r);
      }
      return out;
    },
  };
}

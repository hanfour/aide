// Plan 5A Part 6 Task 6.9 — push-based stream-translator contract.
//
// Per design §10.5, each stream translator is a tiny state machine that
// turns an upstream stream of SSE events into a client-format sequence
// without buffering the whole response. The interface is intentionally
// synchronous + push-based so callers can pipe it directly into a
// `TransformStream` without coordinating async iterators.
//
// Why not the 4A async-generator pattern (`async function*`)? Two
// reasons: (1) generators force the consumer into a `for await` loop
// which is awkward inside a Web Streams `TransformStream`; (2) the
// state-machine shape is much easier to compose for the chat ↔
// responses pivots (see §10.6) — `onEvent(e) { return a.onEvent(e)
// .flatMap(x => b.onEvent(x)); }` is one line. The cost is that
// translators that *want* to be async still can — they can buffer
// internally and emit batches via `onEnd()`.

/**
 * Generic stream-translator state machine.
 *
 * @typeParam U - Upstream event type (e.g. `AnthropicSSEEvent`).
 * @typeParam C - Client event type (e.g. `OpenAIStreamChunk`).
 *
 * Each callback returns an array of zero-or-more client events; an
 * empty array signals "no output for this upstream event" (e.g.
 * Anthropic `content_block_stop` is a no-op for the OpenAI Chat
 * direction). Callers are expected to drain `onEnd()` when the
 * upstream stream closes cleanly, and `onError()` on any upstream
 * exception or SSE-level error event.
 */
export interface StreamTranslator<U, C> {
  onEvent(event: U): C[];
  onEnd(): C[];
  onError(err: { kind: string; message: string }): C[];
}

/**
 * Convenience type for translator factories. Used by the dispatch
 * table (Task 6.11) so callers receive a fresh state-machine instance
 * per request.
 */
export type StreamTranslatorFactory<U, C> = () => StreamTranslator<U, C>;

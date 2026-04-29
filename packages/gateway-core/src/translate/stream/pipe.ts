// Plan 5A Part 6 Task 6.9 — Web Streams pipe wrapper around a
// StreamTranslator state machine.
//
// `pipeStreamTranslator` turns an upstream `ReadableStream<Uint8Array>`
// of SSE bytes into a client-facing `ReadableStream<Uint8Array>`,
// applying:
//   1. `parseUpstream(rawEvent)` — RawSSEEvent → typed upstream U
//      (or null to skip — e.g. ping/heartbeat that the format can
//      filter at parse time).
//   2. `translator.onEvent(u)` — translator state machine.
//   3. `serializeClient(c)` — typed client C → Uint8Array of SSE bytes.
//
// On upstream close: drain `translator.onEnd()` and serialize.
// On upstream error or any thrown exception: call
// `translator.onError({ kind, message })` and serialize the
// resulting events before closing the client stream.

import { SSELineSplitter, type RawSSEEvent } from "./sseLineSplitter.js";
import type { StreamTranslator } from "./types.js";

export interface PipeStreamTranslatorOptions<U, C> {
  upstream: ReadableStream<Uint8Array>;
  translatorFactory: () => StreamTranslator<U, C>;
  /** Returns null to skip the raw event (heartbeats, comments). */
  parseUpstream: (raw: RawSSEEvent) => U | null;
  serializeClient: (event: C) => Uint8Array;
  /**
   * Optional hook invoked when the upstream stream errors. The route
   * handler typically logs / metrics the underlying cause; the pipe
   * itself closes cleanly so the in-flight SSE error event reaches the
   * client.
   */
  onError?: (err: unknown) => void;
}

export function pipeStreamTranslator<U, C>(
  opts: PipeStreamTranslatorOptions<U, C>,
): ReadableStream<Uint8Array> {
  const splitter = new SSELineSplitter();
  const decoder = new TextDecoder("utf-8");
  const translator = opts.translatorFactory();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = opts.upstream.getReader();
      const flushClientEvents = (events: C[]) => {
        for (const ev of events) {
          controller.enqueue(opts.serializeClient(ev));
        }
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const raw of splitter.feed(chunk)) {
            const parsed = opts.parseUpstream(raw);
            if (parsed === null) continue;
            flushClientEvents(translator.onEvent(parsed));
          }
        }
        // Final flush of any tail-buffered raw event.
        for (const raw of splitter.flush()) {
          const parsed = opts.parseUpstream(raw);
          if (parsed === null) continue;
          flushClientEvents(translator.onEvent(parsed));
        }
        flushClientEvents(translator.onEnd());
        controller.close();
      } catch (err) {
        // Drain the translator's `onError` tail and close the output
        // stream cleanly.  Calling `controller.error()` would drop
        // already-enqueued chunks, so for SSE we serialize the error
        // as data events and rely on the consumer to interpret them.
        // The pipe options accept an `onError` hook for the route
        // handler to log / metric the underlying cause.
        try {
          flushClientEvents(
            translator.onError({
              kind: classifyError(err),
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        } catch {
          // swallow — original error already captured by onError hook below
        }
        opts.onError?.(err);
        controller.close();
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function classifyError(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    return String((err as { name: unknown }).name);
  }
  return "unknown";
}

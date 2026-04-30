// Plan 5A PR 9e — OpenAI Responses SSE byte-stream parser.
//
// Symmetric to `parseAnthropicSse`: consumes raw upstream bytes from
// the OpenAI Responses API streaming endpoint and yields typed
// `ResponsesSSEEvent` values.  The protocol uses named SSE events
// (`event: response.output_text.delta\ndata: {…}\n\n`) — the parser
// reuses the generic `SSELineSplitter` from PR #41 and dispatches by
// event name into the typed union from `responsesSseTypes`.
//
// Unknown event types (`response.web_search_call.*`,
// `response.code_interpreter_call.*`, etc.) are dropped silently —
// design A6 limits 5A to text + function-calling.  Unknown event
// names are surfaced via the optional `onUnknownEvent` callback so
// route handlers can metric them without aborting the stream.

import { SSELineSplitter } from "../translate/stream/sseLineSplitter.js";
import type { ResponsesSSEEvent } from "../translate/stream/responsesSseTypes.js";

// `satisfies readonly ResponsesSSEEvent["type"][]` makes adding a new
// type to ResponsesSSEEvent a compile error here too — without it, the
// Set silently drops the new event at runtime.
const KNOWN_EVENT_TYPE_LIST = [
  "response.created",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.output_text.delta",
  "response.function_call_arguments.delta",
  "response.completed",
  "error",
] as const satisfies readonly ResponsesSSEEvent["type"][];

const KNOWN_EVENT_TYPES: ReadonlySet<ResponsesSSEEvent["type"]> = new Set(
  KNOWN_EVENT_TYPE_LIST,
);

export class OpenAIResponsesSseParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "OpenAIResponsesSseParseError";
  }
}

export interface ParseOpenAIResponsesSseOptions {
  /**
   * If a chunk's JSON is malformed, by default throw
   * `OpenAIResponsesSseParseError`.  Set strict=false to skip the bad
   * event with `onError` callback (for resilience).
   */
  strict?: boolean;
  onError?: (err: OpenAIResponsesSseParseError) => void;
  /**
   * Invoked once per dropped event whose name isn't in
   * `KNOWN_EVENT_TYPES` — useful for metrics so an OpenAI protocol
   * change doesn't go silently unhandled.
   */
  onUnknownEvent?: (eventName: string) => void;
}

/**
 * Parse a byte stream of OpenAI Responses SSE into typed events.
 *
 * @param source - upstream byte iterator (typically `res.body` from
 *                 undici)
 */
export async function* parseOpenAIResponsesSse(
  source: AsyncIterable<Uint8Array | Buffer>,
  opts: ParseOpenAIResponsesSseOptions = {},
): AsyncGenerator<ResponsesSSEEvent, void, void> {
  const splitter = new SSELineSplitter();
  const decoder = new TextDecoder("utf-8");
  const strict = opts.strict ?? true;

  const flush = (raw: {
    event?: string;
    data: string;
  }): ResponsesSSEEvent | null => {
    if (raw.data.length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.data);
    } catch (err) {
      const e = new OpenAIResponsesSseParseError(
        `invalid SSE data JSON: ${err instanceof Error ? err.message : String(err)}`,
        raw.data,
      );
      if (strict) throw e;
      opts.onError?.(e);
      return null;
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      const e = new OpenAIResponsesSseParseError(
        "SSE event payload missing `type` field",
        raw.data,
      );
      if (strict) throw e;
      opts.onError?.(e);
      return null;
    }

    const eventType = (parsed as { type: string }).type;
    if (!KNOWN_EVENT_TYPES.has(eventType as ResponsesSSEEvent["type"])) {
      opts.onUnknownEvent?.(eventType);
      return null;
    }
    // Trade-off: we trust the upstream-emitted shape past the `type`
    // field — no per-event Zod validation. The OpenAI Responses SSE
    // protocol is well-documented and stable; full validation would
    // double the per-event cost without catching real upstream bugs.
    // If a malformed payload sneaks through (missing `delta`,
    // missing `output_index`, etc.), downstream code reading those
    // fields will throw a TypeError — same failure mode as the
    // Anthropic parser. Route handlers should treat any throw inside
    // the `for await` as an "abort the stream" signal rather than
    // assuming each event is well-shaped.
    return parsed as ResponsesSSEEvent;
  };

  for await (const chunk of source) {
    const text = decoder.decode(chunk as Buffer, { stream: true });
    for (const raw of splitter.feed(text)) {
      const ev = flush(raw);
      if (ev !== null) yield ev;
    }
  }
  for (const raw of splitter.flush()) {
    const ev = flush(raw);
    if (ev !== null) yield ev;
  }
}

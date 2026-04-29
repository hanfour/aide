// Plan 5A Part 6 Task 6.9 — generic SSE byte → event splitter.
//
// Reads chunks of upstream bytes (TextDecoder-decoded UTF-8) and emits
// raw SSE events: `{ event?, data }`. Handles:
//   * CRLF and LF line endings
//   * Multi-line `data:` (concatenates with `\n` per spec)
//   * Comment lines (`:` prefix) — silently dropped
//   * Empty lines as event terminators
//   * Partial chunks across `feed()` calls
//
// `data: [DONE]` from the OpenAI Chat protocol is surfaced verbatim;
// translators decide what to do with it (typically emit `onEnd()`).
//
// Spec reference: https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream

export interface RawSSEEvent {
  /** The `event:` field — undefined when the stream uses default events. */
  event?: string;
  /** The `data:` field, joined across continuation lines with `\n`. */
  data: string;
}

export class SSELineSplitter {
  private buffer = "";
  private currentEvent: { event?: string; dataLines: string[] } = {
    dataLines: [],
  };

  /**
   * Feeds a chunk of decoded text and returns any complete events
   * emitted as a result. Partial trailing data stays in the internal
   * buffer until the next `feed()` or `flush()`.
   */
  feed(chunk: string): RawSSEEvent[] {
    this.buffer += chunk;
    const out: RawSSEEvent[] = [];
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      // Strip CR if line ended with CRLF.
      const line = this.buffer
        .slice(0, newlineIdx)
        .replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.consumeLine(line, out);
    }
    return out;
  }

  /**
   * Drains any complete event still in the line buffer. Called when
   * the upstream stream closes cleanly. Returns at most one event —
   * the partial-line buffer is discarded since SSE explicitly forbids
   * dispatching unterminated events.
   */
  flush(): RawSSEEvent[] {
    const out: RawSSEEvent[] = [];
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer.replace(/\r$/, ""), out);
      this.buffer = "";
    }
    // An event terminated by EOF without a trailing blank line is
    // still emitted per most real-world SSE producers.
    if (this.currentEvent.dataLines.length > 0) {
      out.push({
        ...(this.currentEvent.event !== undefined && {
          event: this.currentEvent.event,
        }),
        data: this.currentEvent.dataLines.join("\n"),
      });
      this.currentEvent = { dataLines: [] };
    }
    return out;
  }

  private consumeLine(line: string, out: RawSSEEvent[]): void {
    if (line.length === 0) {
      // Blank line dispatches the current event (if any).
      if (this.currentEvent.dataLines.length === 0) {
        // No data accumulated → ignore (per spec).
        this.currentEvent = { dataLines: [] };
        return;
      }
      out.push({
        ...(this.currentEvent.event !== undefined && {
          event: this.currentEvent.event,
        }),
        data: this.currentEvent.dataLines.join("\n"),
      });
      this.currentEvent = { dataLines: [] };
      return;
    }
    if (line.startsWith(":")) {
      // Comment line — silently discard.
      return;
    }
    const colonIdx = line.indexOf(":");
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value =
      colonIdx === -1 ? "" : line.slice(colonIdx + 1);
    // SSE spec: a single leading space is consumed.
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      this.currentEvent.event = value;
    } else if (field === "data") {
      this.currentEvent.dataLines.push(value);
    }
    // `id` and `retry` fields are ignored — translators don't need them.
  }
}

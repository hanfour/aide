/**
 * Push-mode SSE usage extractor for the streaming `/v1/messages` path
 * (Plan 4A Part 7, Sub-task C).
 *
 * Purpose
 * -------
 * The streaming route's `SmartBuffer` owns bytes between upstream and client
 * and must NOT be interfered with.  To build a usage-log payload we need to
 * peek at the same byte stream and pull out:
 *
 *   - `message.model`             (from the first `message_start` event)
 *   - `message.usage.input_tokens`+ cache_* counts (from `message_start`)
 *   - `message.usage.output_tokens` (from `message_delta`, which carries the
 *     running — and ultimately final — output token count)
 *
 * Design
 * ------
 * Feed bytes in via `push(chunk)` directly off the upstream stream, BEFORE
 * they reach `SmartBuffer`.  The extractor scans for SSE event boundaries
 * (`\n\n` after the CRLF/LF normalisation pass) and decodes each completed
 * event just far enough to pluck the fields above.  Partial bytes are
 * retained for the next `push()`.
 *
 * Resilience
 * ----------
 * Every parse step is defensive: malformed JSON, missing `event:` lines,
 * unknown event types, partial events, or an upstream that truncates
 * mid-event all yield "best-effort" snapshots — the extractor never throws.
 * Worst case: `model === ""` and zero tokens, which still produces a valid
 * forensic usage-log row.
 *
 * Not a parser
 * ------------
 * This is intentionally lighter than `parseAnthropicSse` (which is a full
 * AsyncGenerator-based parser used elsewhere in gateway-core).  The
 * streaming route hands raw bytes to `SmartBuffer` and has no use for typed
 * events — only the final token + model snapshot.  Wrapping the upstream
 * async iterable in a proper parser would require forking or teeing the
 * stream, which adds complexity without benefit here.
 */

export interface StreamUsageSnapshot {
  /** From `message_start.message.model`; `""` if never observed. */
  model: string;
  /** From `message_start.message.usage.input_tokens`; 0 if absent. */
  input_tokens: number;
  /**
   * From the LAST `message_delta.usage.output_tokens` seen (running count
   * that stabilises at final).  Falls back to
   * `message_start.message.usage.output_tokens` when no delta ever arrives
   * (e.g., upstream truncated right after `message_start`).
   */
  output_tokens: number;
  /** From `message_start.message.usage.cache_creation_input_tokens`; 0 if absent. */
  cache_creation_tokens: number;
  /** From `message_start.message.usage.cache_read_input_tokens`; 0 if absent. */
  cache_read_tokens: number;
}

export class StreamUsageExtractor {
  /**
   * Rolling string buffer of not-yet-consumed bytes.  SSE is UTF-8 per spec;
   * we normalise CRLF → LF up front so the `\n\n` event-boundary scan is
   * uniform regardless of upstream quirks.  Holding a string (rather than
   * Buffer) is safe because the decoder streams with `{ stream: true }`.
   */
  #buf = "";

  /** UTF-8 streaming decoder — carries partial multi-byte sequences across pushes. */
  readonly #decoder = new TextDecoder("utf-8");

  #model = "";
  #inputTokens = 0;
  #outputTokensFromStart = 0;
  #outputTokensFromDelta: number | null = null;
  #cacheCreationTokens = 0;
  #cacheReadTokens = 0;

  /**
   * Feed a chunk of raw upstream bytes.  Internally scans for completed SSE
   * events (`\n\n`) and updates the running usage snapshot.  Tolerates any
   * malformed input silently — the worst that happens is the event is
   * ignored and the current snapshot stays at its previous best-effort
   * values.
   */
  push(chunk: Buffer): void {
    if (chunk.length === 0) return;

    // Append decoded bytes and normalise line endings once.
    this.#buf += this.#decoder.decode(chunk, { stream: true });
    this.#buf = this.#buf.replace(/\r\n/g, "\n");

    // Consume every completed event (terminated by a blank line == `\n\n`).
    let boundary: number;
    while ((boundary = this.#buf.indexOf("\n\n")) !== -1) {
      const raw = this.#buf.slice(0, boundary);
      this.#buf = this.#buf.slice(boundary + 2);
      this.#processEvent(raw);
    }
  }

  /**
   * Return the current best-effort snapshot. Callers can invoke multiple
   * times; each call returns a fresh object — mutating it does NOT affect
   * future snapshots (immutable-snapshot contract).
   */
  snapshot(): StreamUsageSnapshot {
    return {
      model: this.#model,
      input_tokens: this.#inputTokens,
      output_tokens:
        this.#outputTokensFromDelta !== null
          ? this.#outputTokensFromDelta
          : this.#outputTokensFromStart,
      cache_creation_tokens: this.#cacheCreationTokens,
      cache_read_tokens: this.#cacheReadTokens,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Parse one SSE event block (the chunk between two `\n\n` boundaries).
   *
   * Per the SSE spec an event may contain:
   *   - comment lines (`:...`) — ignored
   *   - `event: <type>` line(s) — we trust the JSON `type` instead, but parse
   *     this defensively because upstream Anthropic sets it correctly
   *   - `data: <payload>` line(s) — concatenated with `\n` per spec
   *
   * We prefer the JSON `type` field inside `data` for classification (matches
   * how `parseAnthropicSse` in gateway-core works) — this tolerates
   * data-only frames where the `event:` line is omitted.
   */
  #processEvent(raw: string): void {
    if (raw.length === 0) return;

    const lines = raw.split("\n");
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.length === 0 || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        // Per spec: strip exactly one optional space after the colon.
        const value = line[5] === " " ? line.slice(6) : line.slice(5);
        dataLines.push(value);
      }
      // `event:`, `id:`, `retry:` — ignored; classification uses JSON type.
    }

    if (dataLines.length === 0) return;

    const dataStr = dataLines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      // Malformed JSON — ignore; snapshot keeps prior best-effort values.
      return;
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      return;
    }

    const type = (parsed as { type: string }).type;
    if (type === "message_start") {
      this.#handleMessageStart(parsed as Record<string, unknown>);
    } else if (type === "message_delta") {
      this.#handleMessageDelta(parsed as Record<string, unknown>);
    }
    // All other types (content_block_*, ping, error, message_stop) are
    // irrelevant for usage extraction and silently ignored.
  }

  #handleMessageStart(ev: Record<string, unknown>): void {
    const message = ev.message;
    if (!message || typeof message !== "object") return;
    const m = message as Record<string, unknown>;

    if (typeof m.model === "string" && m.model.length > 0) {
      this.#model = m.model;
    }

    const usage = m.usage;
    if (usage && typeof usage === "object") {
      const u = usage as Record<string, unknown>;
      this.#inputTokens = toNonNegInt(u.input_tokens);
      this.#outputTokensFromStart = toNonNegInt(u.output_tokens);
      this.#cacheCreationTokens = toNonNegInt(u.cache_creation_input_tokens);
      this.#cacheReadTokens = toNonNegInt(u.cache_read_input_tokens);
    }
  }

  #handleMessageDelta(ev: Record<string, unknown>): void {
    const usage = ev.usage;
    if (!usage || typeof usage !== "object") return;
    const u = usage as Record<string, unknown>;
    // `output_tokens` on `message_delta` is the running final count — keep
    // the latest value so the snapshot reflects the stream's final state
    // even if more delta events arrive later.
    if (u.output_tokens !== undefined) {
      this.#outputTokensFromDelta = toNonNegInt(u.output_tokens);
    }
  }
}

function toNonNegInt(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

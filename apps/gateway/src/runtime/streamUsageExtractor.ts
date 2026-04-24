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

/** A single assembled text block from the stream. */
export interface StreamTextBlock {
  type: "text";
  text: string;
}

/** A single assembled tool_use block from the stream. */
export interface StreamToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/** Content block types that can appear in an assembled transcript. */
export type StreamContentBlock = StreamTextBlock | StreamToolUseBlock;

/**
 * Anthropic-shaped response assembled from SSE events — mirrors the shape of a
 * non-streaming `/v1/messages` response so body-capture consumers can treat
 * streaming and non-streaming captures uniformly.
 *
 * Fields are `null` if the corresponding SSE event never arrived (e.g. stream
 * cut before `message_start` → `id` and `model` are `null`).
 */
export interface StreamTranscript {
  id: string | null;
  type: "message";
  role: "assistant";
  model: string | null;
  content: StreamContentBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
}

/**
 * Mutable in-progress content block used during transcript accumulation.
 * Distinct from the exported `StreamContentBlock` type because tool_use input
 * arrives as partial JSON fragments (buffered as a string until
 * `content_block_stop` triggers a parse attempt).
 */
type InProgressTextBlock = { type: "text"; text: string };
type InProgressToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  inputBuf: string; // accumulated raw JSON fragments
};
type InProgressBlock = InProgressTextBlock | InProgressToolUseBlock;

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

  /**
   * True when the previous decoded segment ended with a lone `\r` that we
   * stripped pending the next push.  Lets us safely fold a `\r\n` sequence
   * even when the CR and LF arrive in different chunks, without paying the
   * O(N²) cost of re-normalising the whole accumulated buffer on every push.
   */
  #pendingCR = false;

  // ── Usage extraction state ──────────────────────────────────────────────────
  #model = "";
  #inputTokens = 0;
  #outputTokensFromStart = 0;
  #outputTokensFromDelta: number | null = null;
  #cacheCreationTokens = 0;
  #cacheReadTokens = 0;

  // ── Transcript accumulation state ──────────────────────────────────────────
  /** From `message_start.message.id`; null until observed. */
  #transcriptId: string | null = null;
  /** From `message_start.message.model`; null until observed. */
  #transcriptModel: string | null = null;
  /** Final stop_reason from `message_delta.delta.stop_reason`. */
  #stopReason: string | null = null;
  /** Whether `message_start` has been observed (guards null usage vs zero). */
  #hasMessageStart = false;
  /** Finalised content blocks, in order. */
  #contentBlocks: StreamContentBlock[] = [];
  /** The block currently being assembled (between block_start and block_stop). */
  #currentBlock: InProgressBlock | null = null;

  /**
   * Feed a chunk of raw upstream bytes.  Internally scans for completed SSE
   * events (`\n\n`) and updates the running usage snapshot.  Tolerates any
   * malformed input silently — the worst that happens is the event is
   * ignored and the current snapshot stays at its previous best-effort
   * values.
   */
  push(chunk: Buffer): void {
    if (chunk.length === 0) return;

    // Decode just the new bytes and normalise the new segment only — the
    // previous `this.#buf = this.#buf.replace(...)` form ran on the whole
    // accumulated buffer on every push (O(N²) over the stream).  Restrict
    // normalisation to the freshly-decoded slice; carry a single trailing
    // `\r` over to the next push so a `\r\n` split across chunk boundaries
    // still folds correctly.  This is the canonical SSE-parser pattern.
    let decoded = this.#decoder.decode(chunk, { stream: true });
    if (decoded.length === 0) return;

    if (this.#pendingCR) {
      decoded = "\r" + decoded;
      this.#pendingCR = false;
    }
    if (decoded.endsWith("\r")) {
      decoded = decoded.slice(0, -1);
      this.#pendingCR = true;
    }
    decoded = decoded.replace(/\r\n/g, "\n");
    this.#buf += decoded;

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

  /**
   * Return the assembled transcript shaped like a non-streaming Anthropic
   * `/v1/messages` response.  Safe to call at any point — partial streams
   * (disconnected mid-message, stream cut before `message_start`) produce a
   * best-effort object with null fields rather than throwing.
   *
   * Each call returns a new object — immutable-snapshot contract.
   */
  getAssembledTranscript(): StreamTranscript {
    const usageSnap = this.snapshot();
    return {
      id: this.#transcriptId,
      type: "message",
      role: "assistant",
      model: this.#transcriptModel,
      content: [...this.#contentBlocks],
      stop_reason: this.#stopReason,
      usage: this.#hasMessageStart
        ? {
            input_tokens: usageSnap.input_tokens,
            output_tokens: usageSnap.output_tokens,
            cache_creation_input_tokens: usageSnap.cache_creation_tokens,
            cache_read_input_tokens: usageSnap.cache_read_tokens,
          }
        : null,
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
    } else if (type === "content_block_start") {
      this.#handleContentBlockStart(parsed as Record<string, unknown>);
    } else if (type === "content_block_delta") {
      this.#handleContentBlockDelta(parsed as Record<string, unknown>);
    } else if (type === "content_block_stop") {
      this.#handleContentBlockStop();
    }
    // ping, error, message_stop — irrelevant for extraction/transcript.
  }

  #handleMessageStart(ev: Record<string, unknown>): void {
    const message = ev.message;
    if (!message || typeof message !== "object") return;
    const m = message as Record<string, unknown>;

    if (typeof m.model === "string" && m.model.length > 0) {
      this.#model = m.model;
      this.#transcriptModel = m.model;
    }

    if (typeof m.id === "string") {
      this.#transcriptId = m.id;
    }

    const usage = m.usage;
    if (usage && typeof usage === "object") {
      const u = usage as Record<string, unknown>;
      this.#inputTokens = toNonNegInt(u.input_tokens);
      this.#outputTokensFromStart = toNonNegInt(u.output_tokens);
      this.#cacheCreationTokens = toNonNegInt(u.cache_creation_input_tokens);
      this.#cacheReadTokens = toNonNegInt(u.cache_read_input_tokens);
    }

    this.#hasMessageStart = true;
  }

  #handleMessageDelta(ev: Record<string, unknown>): void {
    const usage = ev.usage;
    if (usage && typeof usage === "object") {
      const u = usage as Record<string, unknown>;
      // `output_tokens` on `message_delta` is the running final count — keep
      // the latest value so the snapshot reflects the stream's final state
      // even if more delta events arrive later.
      if (u.output_tokens !== undefined) {
        this.#outputTokensFromDelta = toNonNegInt(u.output_tokens);
      }
    }

    // Capture stop_reason from the delta payload.
    const delta = ev.delta;
    if (delta && typeof delta === "object") {
      const d = delta as Record<string, unknown>;
      if (typeof d.stop_reason === "string") {
        this.#stopReason = d.stop_reason;
      }
    }
  }

  #handleContentBlockStart(ev: Record<string, unknown>): void {
    // Finalise any previously open block that didn't receive a block_stop
    // (defensive: shouldn't happen in a well-formed stream).
    this.#finaliseCurrentBlock();

    const cb = ev.content_block;
    if (!cb || typeof cb !== "object") return;
    const block = cb as Record<string, unknown>;

    if (block.type === "text") {
      this.#currentBlock = { type: "text", text: "" };
    } else if (block.type === "tool_use") {
      const id = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "";
      this.#currentBlock = { type: "tool_use", id, name, inputBuf: "" };
    }
    // Unknown block types are ignored — #currentBlock stays null.
  }

  #handleContentBlockDelta(ev: Record<string, unknown>): void {
    if (!this.#currentBlock) return;

    const delta = ev.delta;
    if (!delta || typeof delta !== "object") return;
    const d = delta as Record<string, unknown>;

    if (
      d.type === "text_delta" &&
      this.#currentBlock.type === "text" &&
      typeof d.text === "string"
    ) {
      // Append text delta to current text block (mutation is intentional here —
      // #currentBlock is internal mutable state, not exposed to callers).
      this.#currentBlock.text += d.text;
    } else if (
      d.type === "input_json_delta" &&
      this.#currentBlock.type === "tool_use" &&
      typeof d.partial_json === "string"
    ) {
      // Buffer partial JSON fragments; parse at content_block_stop.
      this.#currentBlock.inputBuf += d.partial_json;
    }
  }

  #handleContentBlockStop(): void {
    this.#finaliseCurrentBlock();
  }

  /**
   * Finalize the current in-progress block and push it onto #contentBlocks.
   * For tool_use blocks, attempts to parse the accumulated JSON buffer; on
   * failure (partial stream / malformed JSON) falls back to the raw string so
   * the block is still captured.
   */
  #finaliseCurrentBlock(): void {
    if (!this.#currentBlock) return;

    if (this.#currentBlock.type === "text") {
      this.#contentBlocks = [
        ...this.#contentBlocks,
        { type: "text", text: this.#currentBlock.text },
      ];
    } else {
      // tool_use — parse accumulated JSON buffer.
      let parsedInput: unknown = {};
      if (this.#currentBlock.inputBuf.length > 0) {
        try {
          parsedInput = JSON.parse(this.#currentBlock.inputBuf);
        } catch {
          // Partial / malformed JSON (mid-stream disconnect) — store raw
          // string so the block is still captured for forensic purposes.
          parsedInput = this.#currentBlock.inputBuf;
        }
      }
      this.#contentBlocks = [
        ...this.#contentBlocks,
        {
          type: "tool_use",
          id: this.#currentBlock.id,
          name: this.#currentBlock.name,
          input: parsedInput,
        },
      ];
    }

    this.#currentBlock = null;
  }
}

function toNonNegInt(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

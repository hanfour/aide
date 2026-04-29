// Anthropic SSE stream parser.
// Parses an AsyncIterable<Buffer> of raw SSE bytes into typed Anthropic SSE events.

// ---------------------------------------------------------------------------
// Anthropic SSE event types (canonical location)
// ---------------------------------------------------------------------------

interface MessageStartUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface MessageStartEvent {
  type: "message_start";
  message: {
    id: string;
    model: string;
    role: "assistant";
    content: [];
    stop_reason: null;
    stop_sequence: null;
    usage: MessageStartUsage;
  };
}

export interface ContentBlockStartTextEvent {
  type: "content_block_start";
  index: number;
  content_block: { type: "text"; text: "" };
}

export interface ContentBlockStartToolUseEvent {
  type: "content_block_start";
  index: number;
  content_block: {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, never>;
  };
}

export type ContentBlockStartEvent =
  | ContentBlockStartTextEvent
  | ContentBlockStartToolUseEvent;

export interface ContentBlockDeltaTextEvent {
  type: "content_block_delta";
  index: number;
  delta: { type: "text_delta"; text: string };
}

export interface ContentBlockDeltaJsonEvent {
  type: "content_block_delta";
  index: number;
  delta: { type: "input_json_delta"; partial_json: string };
}

export type ContentBlockDeltaEvent =
  | ContentBlockDeltaTextEvent
  | ContentBlockDeltaJsonEvent;

export interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface MessageDeltaEvent {
  type: "message_delta";
  delta: {
    // "refusal" added in Plan 5A (matches AnthropicMessagesResponse.stop_reason
    // so cross-format reverse projections via stopReasonMap round-trip).
    stop_reason:
      | "end_turn"
      | "max_tokens"
      | "stop_sequence"
      | "tool_use"
      | "refusal";
    stop_sequence: string | null;
  };
  usage: { output_tokens: number };
}

export interface MessageStopEvent {
  type: "message_stop";
}

export interface ErrorEvent {
  type: "error";
  error: { type: string; message: string };
}

export interface PingEvent {
  type: "ping";
}

export type AnthropicSSEEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | ErrorEvent
  | PingEvent;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class SseParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "SseParseError";
  }
}

export interface ParseOptions {
  /**
   * If a chunk's JSON is malformed, by default throw SseParseError.
   * Set strict=false to skip the bad event with onError callback (for resilience).
   */
  strict?: boolean;
  onError?: (err: SseParseError) => void;
}

export async function* parseAnthropicSse(
  source: AsyncIterable<Uint8Array | Buffer>,
  opts: ParseOptions = {},
): AsyncGenerator<AnthropicSSEEvent, void, void> {
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let dataLines: string[] = [];

  function flushEvent(): AnthropicSSEEvent | undefined {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join("\n");
    dataLines = [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      const e = new SseParseError(
        `invalid SSE data JSON: ${err instanceof Error ? err.message : String(err)}`,
        data,
      );
      if (opts.strict ?? true) throw e;
      opts.onError?.(e);
      return undefined;
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      const e = new SseParseError("SSE event missing type field", data);
      if (opts.strict ?? true) throw e;
      opts.onError?.(e);
      return undefined;
    }

    return parsed as AnthropicSSEEvent;
  }

  function processLine(line: string): AnthropicSSEEvent | undefined {
    if (line === "") {
      return flushEvent();
    }
    if (line.startsWith(":")) {
      // comment — ignore
      return undefined;
    }
    if (line.startsWith("data:")) {
      // Per SSE spec: strip optional single space after colon
      const value = line[5] === " " ? line.slice(6) : line.slice(5);
      dataLines = [...dataLines, value];
    }
    // Ignore 'event:', 'id:', 'retry:' — we use the JSON type field
    return undefined;
  }

  for await (const chunk of source) {
    buf += decoder.decode(chunk as Buffer, { stream: true });
    // Normalize CRLF to LF for predictable splitting
    buf = buf.replace(/\r\n/g, "\n");

    let nlIdx: number;
    while ((nlIdx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nlIdx);
      buf = buf.slice(nlIdx + 1);
      const event = processLine(line);
      if (event !== undefined) yield event;
    }
  }

  // Flush trailing decoder bytes
  buf += decoder.decode();
  buf = buf.replace(/\r\n/g, "\n");

  if (buf.length > 0) {
    // Process any remaining lines (no trailing newline)
    for (const line of buf.split("\n")) {
      const event = processLine(line);
      if (event !== undefined) yield event;
    }
  }

  // If stream ended without trailing blank line, flush final accumulated event
  const trailing = flushEvent();
  if (trailing !== undefined) yield trailing;
}

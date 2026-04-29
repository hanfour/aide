import { describe, it, expect } from "vitest";
import { pipeStreamTranslator } from "../../src/translate/stream/pipe.js";
import type { StreamTranslator } from "../../src/translate/stream/types.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeUpstream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

interface PassthroughEvent {
  data: string;
}

function makePassthroughTranslator(): StreamTranslator<
  PassthroughEvent,
  PassthroughEvent
> {
  return {
    onEvent: (e) => [e],
    onEnd: () => [{ data: "[END]" }],
    onError: (err) => [{ data: `[ERR:${err.kind}]` }],
  };
}

describe("pipeStreamTranslator", () => {
  it("pipes parsed events through the translator and serializes them back", async () => {
    const upstream = makeUpstream(["data: alpha\n\n", "data: beta\n\n"]);
    const out = pipeStreamTranslator({
      upstream,
      translatorFactory: makePassthroughTranslator,
      parseUpstream: (raw) => ({ data: raw.data }),
      serializeClient: (e) => enc.encode(`out: ${e.data}\n`),
    });
    expect(await collect(out)).toBe("out: alpha\nout: beta\nout: [END]\n");
  });

  it("returning null from parseUpstream skips the raw event", async () => {
    const upstream = makeUpstream(["data: keep\n\n", "data: skip\n\n"]);
    const out = pipeStreamTranslator({
      upstream,
      translatorFactory: makePassthroughTranslator,
      parseUpstream: (raw) => (raw.data === "skip" ? null : { data: raw.data }),
      serializeClient: (e) => enc.encode(`out: ${e.data}\n`),
    });
    expect(await collect(out)).toBe("out: keep\nout: [END]\n");
  });

  it("calls onError + tail and notifies onError hook (closes cleanly)", async () => {
    // Emit data first chunk on first pull, then error on the next pull
    // — guarantees the pipe sees the data before the error.
    let pulled = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === 0) {
          controller.enqueue(enc.encode("data: first\n\n"));
          pulled++;
        } else {
          controller.error(new Error("boom"));
        }
      },
    });
    let onErrorCalled: unknown = null;
    const stream = pipeStreamTranslator({
      upstream,
      translatorFactory: makePassthroughTranslator,
      parseUpstream: (raw) => ({ data: raw.data }),
      serializeClient: (e) => enc.encode(`out: ${e.data}\n`),
      onError: (err) => {
        onErrorCalled = err;
      },
    });
    // SSE-friendly: error event emitted as data, stream closes cleanly,
    // route handler is notified via the onError hook.
    const collected = await collect(stream);
    expect(collected).toBe("out: first\nout: [ERR:Error]\n");
    expect(onErrorCalled).toBeInstanceOf(Error);
    expect((onErrorCalled as Error).message).toBe("boom");
  });

  it("flushes the line splitter on EOF (event without trailing blank)", async () => {
    const upstream = makeUpstream(["data: tail-no-blank"]);
    const out = pipeStreamTranslator({
      upstream,
      translatorFactory: makePassthroughTranslator,
      parseUpstream: (raw) => ({ data: raw.data }),
      serializeClient: (e) => enc.encode(`out: ${e.data}\n`),
    });
    expect(await collect(out)).toBe("out: tail-no-blank\nout: [END]\n");
  });
});

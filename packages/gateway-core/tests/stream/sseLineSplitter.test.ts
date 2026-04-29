import { describe, it, expect } from "vitest";
import { SSELineSplitter } from "../../src/translate/stream/sseLineSplitter.js";

describe("SSELineSplitter", () => {
  it("emits a single event terminated by a blank line", () => {
    const s = new SSELineSplitter();
    const out = s.feed("data: hello\n\n");
    expect(out).toEqual([{ data: "hello" }]);
  });

  it("captures the event field separately from data", () => {
    const s = new SSELineSplitter();
    const out = s.feed("event: response.created\ndata: {}\n\n");
    expect(out).toEqual([{ event: "response.created", data: "{}" }]);
  });

  it("joins multi-line data with newlines", () => {
    const s = new SSELineSplitter();
    const out = s.feed("data: line1\ndata: line2\n\n");
    expect(out).toEqual([{ data: "line1\nline2" }]);
  });

  it("handles CRLF line endings", () => {
    const s = new SSELineSplitter();
    const out = s.feed("data: hi\r\n\r\n");
    expect(out).toEqual([{ data: "hi" }]);
  });

  it("ignores comment lines (`:` prefix)", () => {
    const s = new SSELineSplitter();
    const out = s.feed(": keepalive\ndata: x\n\n");
    expect(out).toEqual([{ data: "x" }]);
  });

  it("ignores fields it doesn't understand (id, retry)", () => {
    const s = new SSELineSplitter();
    const out = s.feed("id: 1\nretry: 5000\ndata: foo\n\n");
    expect(out).toEqual([{ data: "foo" }]);
  });

  it("buffers across feed boundaries", () => {
    const s = new SSELineSplitter();
    expect(s.feed("data: par")).toEqual([]);
    expect(s.feed("tial\n")).toEqual([]);
    expect(s.feed("\n")).toEqual([{ data: "partial" }]);
  });

  it("emits multiple events from one feed call", () => {
    const s = new SSELineSplitter();
    const out = s.feed("data: a\n\ndata: b\n\n");
    expect(out).toEqual([{ data: "a" }, { data: "b" }]);
  });

  it("flush() emits a tail event without trailing blank line", () => {
    const s = new SSELineSplitter();
    s.feed("data: tail");
    expect(s.flush()).toEqual([{ data: "tail" }]);
  });

  it("flush() returns empty when buffer is clean", () => {
    const s = new SSELineSplitter();
    s.feed("data: x\n\n");
    expect(s.flush()).toEqual([]);
  });

  it("strips a single leading space from the value (per spec)", () => {
    const s = new SSELineSplitter();
    expect(s.feed("data:  two-spaces\n\n")).toEqual([
      { data: " two-spaces" },
    ]);
  });

  it("ignores blank lines between events without dispatching empty events", () => {
    const s = new SSELineSplitter();
    expect(s.feed("\n\n\ndata: x\n\n")).toEqual([{ data: "x" }]);
  });
});

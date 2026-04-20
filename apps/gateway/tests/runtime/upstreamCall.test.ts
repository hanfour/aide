import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { callUpstreamMessages } from "../../src/runtime/upstreamCall.js";

let server: Server;
let baseUrl: string;
let lastRequest: { headers: IncomingMessage["headers"]; body: string } | null = null;
let nextResponse: { status: number; body: string; contentType?: string };

beforeAll(async () => {
  nextResponse = { status: 200, body: "{}" };
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastRequest = { headers: req.headers, body };
      res.statusCode = nextResponse.status;
      res.setHeader("content-type", nextResponse.contentType ?? "application/json");
      res.end(nextResponse.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  lastRequest = null;
  nextResponse = { status: 200, body: '{"id":"msg_test","content":[]}' };
});

describe("callUpstreamMessages", () => {
  it("1. uses x-api-key + anthropic-version for api_key credential", async () => {
    nextResponse = { status: 200, body: '{"id":"msg_t","content":[]}' };
    const out = await callUpstreamMessages({
      baseUrl,
      body: Buffer.from('{"model":"claude","max_tokens":10}'),
      credential: { type: "api_key", apiKey: "sk-test" },
    });
    expect(out.kind).toBe("non-stream");
    expect(lastRequest?.headers["x-api-key"]).toBe("sk-test");
    expect(lastRequest?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(lastRequest?.headers["authorization"]).toBeUndefined();
    expect(lastRequest?.headers["anthropic-beta"]).toBeUndefined();
  });

  it("2. uses Authorization Bearer + anthropic-beta + anthropic-version for oauth credential", async () => {
    nextResponse = { status: 200, body: '{"id":"msg_t","content":[]}' };
    const out = await callUpstreamMessages({
      baseUrl,
      body: Buffer.from('{"model":"claude","max_tokens":10}'),
      credential: {
        type: "oauth",
        accessToken: "tok-access",
        refreshToken: "tok-refresh",
        expiresAt: new Date("2026-12-31T00:00:00Z"),
      },
    });
    expect(out.kind).toBe("non-stream");
    expect(lastRequest?.headers["authorization"]).toBe("Bearer tok-access");
    expect(lastRequest?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(lastRequest?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(lastRequest?.headers["x-api-key"]).toBeUndefined();
  });

  it("3. non-stream returns Buffer body that parses correctly", async () => {
    const responsePayload = '{"id":"msg_test","content":[]}';
    nextResponse = { status: 200, body: responsePayload };
    const out = await callUpstreamMessages({
      baseUrl,
      body: Buffer.from('{"model":"claude","max_tokens":10}'),
      credential: { type: "api_key", apiKey: "sk-test" },
    });
    expect(out.kind).toBe("non-stream");
    if (out.kind === "non-stream") {
      expect(Buffer.isBuffer(out.body)).toBe(true);
      const parsed = JSON.parse(out.body.toString("utf8"));
      expect(parsed).toEqual({ id: "msg_test", content: [] });
    }
  });

  it("4. status code is propagated (400 returns 400)", async () => {
    nextResponse = { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error"}}' };
    const out = await callUpstreamMessages({
      baseUrl,
      body: Buffer.from('{"model":"claude","max_tokens":10}'),
      credential: { type: "api_key", apiKey: "sk-test" },
    });
    expect(out.kind).toBe("non-stream");
    expect(out.status).toBe(400);
  });

  it("5. stream=true body returns kind:'stream' with AsyncIterable body", async () => {
    nextResponse = {
      status: 200,
      body: "data: {\"type\":\"message_start\"}\n\ndata: [DONE]\n\n",
      contentType: "text/event-stream",
    };
    const out = await callUpstreamMessages({
      baseUrl,
      body: Buffer.from('{"model":"claude","max_tokens":10,"stream":true}'),
      credential: { type: "api_key", apiKey: "sk-test" },
    });
    expect(out.kind).toBe("stream");
    if (out.kind === "stream") {
      expect(typeof out.body[Symbol.asyncIterator]).toBe("function");
      // Drain and verify we get some bytes back
      const chunks: Buffer[] = [];
      for await (const chunk of out.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const full = Buffer.concat(chunks).toString("utf8");
      expect(full).toContain("message_start");
    }
  });

  it("6. AbortSignal cancels in-flight request", async () => {
    // Use a slow server response by not responding immediately — but since our
    // test server responds right away, we create a fresh slow server for this test.
    const slowServer = createServer((_req, res) => {
      // Delay 500ms before responding
      setTimeout(() => {
        res.statusCode = 200;
        res.end("{}");
      }, 500);
    });
    await new Promise<void>((r) => slowServer.listen(0, "127.0.0.1", r));
    const slowAddr = slowServer.address() as AddressInfo;
    const slowBaseUrl = `http://127.0.0.1:${slowAddr.port}`;

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);

    await expect(
      callUpstreamMessages({
        baseUrl: slowBaseUrl,
        body: Buffer.from('{"model":"claude","max_tokens":10}'),
        credential: { type: "api_key", apiKey: "sk-test" },
        signal: ac.signal,
      }),
    ).rejects.toThrow();

    await new Promise<void>((r) => slowServer.close(() => r()));
  });

  it("7. forwardHeaders are passed through to upstream", async () => {
    nextResponse = { status: 200, body: '{"id":"msg_t","content":[]}' };
    await callUpstreamMessages({
      baseUrl,
      body: Buffer.from('{"model":"claude","max_tokens":10}'),
      credential: { type: "api_key", apiKey: "sk-test" },
      forwardHeaders: { "x-extra": "yes" },
    });
    expect(lastRequest?.headers["x-extra"]).toBe("yes");
  });

  it("8. forbidden hop-by-hop headers are stripped from forwardHeaders", async () => {
    nextResponse = { status: 200, body: '{"id":"msg_t","content":[]}' };
    await callUpstreamMessages({
      baseUrl,
      body: Buffer.from('{"model":"claude","max_tokens":10}'),
      credential: { type: "api_key", apiKey: "sk-test" },
      forwardHeaders: {
        "host": "evil.example",
        "content-length": "9999",
        "connection": "close",
        "x-safe": "value",
      },
    });
    // host should be the actual server host (127.0.0.1:port), not evil.example
    expect(lastRequest?.headers["host"]).not.toBe("evil.example");
    // content-length and connection should not be the injected values
    expect(lastRequest?.headers["content-length"]).not.toBe("9999");
    expect(lastRequest?.headers["connection"]).not.toBe("close");
    // safe header should still pass through
    expect(lastRequest?.headers["x-safe"]).toBe("value");
  });
});

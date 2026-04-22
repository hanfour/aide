/**
 * Fake Anthropic upstream for E2E tests.
 *
 * Boots a tiny node:http server that mimics the non-streaming
 * `POST /v1/messages` response shape. Records every request so specs can
 * assert on what the gateway forwarded (headers + parsed JSON body).
 *
 * Used by:
 *   - apps/web/e2e/fixtures/run-fake-anthropic.ts (Playwright webServer + CI)
 *   - E2E specs (future; Part 12.1/12.2) importing startFakeAnthropic directly
 *     when they need per-spec isolation.
 *
 * Intentionally stdlib-only and ≤100 lines. Richer upstream behaviour
 * (streaming, 4xx) lives in gateway integration tests.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FakeAnthropic {
  url: string;
  close: () => Promise<void>;
  requests: readonly FakeRequest[];
}

export interface StartFakeAnthropicOpts {
  /** Port to bind. Defaults to 0 (ephemeral). */
  port?: number;
}

const CANNED_MESSAGE_RESPONSE = {
  id: "msg_fake_e2e",
  type: "message" as const,
  role: "assistant" as const,
  content: [{ type: "text", text: "ok" }],
  model: "claude-3-haiku-20240307",
  stop_reason: "end_turn" as const,
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 1 },
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

export async function startFakeAnthropic(
  opts: StartFakeAnthropicOpts = {},
): Promise<FakeAnthropic> {
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      const body = method === "POST" ? await readBody(req) : null;
      requests.push({ method, url, headers: { ...req.headers }, body });

      // GET / is the ready-probe target for wait-on / Playwright's webServer.
      // Returning 200 JSON avoids bouncing wait-on off a 404 (its default
      // acceptance is 2xx/3xx).
      if (method === "GET" && (url === "/" || url === "/health")) {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && url === "/v1/messages") {
        sendJson(res, 200, CANNED_MESSAGE_RESPONSE);
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    })().catch((err) => {
      sendJson(res, 500, {
        error: "fake_upstream_failure",
        detail: String(err),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Bind to 0.0.0.0 instead of 127.0.0.1 so probes via `localhost` work
    // regardless of IPv4-vs-IPv6 resolution order (CI runners' /etc/gai.conf
    // is not consistent across images). The fake is still loopback-only
    // because nothing on the public network can route to an ephemeral CI
    // runner — 0.0.0.0 here is pragmatism, not a security change.
    server.listen(opts.port ?? 0, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  // Callers probe via `localhost:<port>`; advertising that here keeps us
  // consistent with wait-on / playwright webServer readiness URLs.
  const url = `http://localhost:${addr.port}`;

  const close = (): Promise<void> =>
    new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );

  return { url, close, requests };
}

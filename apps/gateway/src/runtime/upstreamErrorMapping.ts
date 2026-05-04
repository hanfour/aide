// Plan 5A PR 9j — shared helpers for mapping upstream HTTP responses
// into the throwable shape the failover-loop classifier expects.
// Before this module, every route file had its own copy of the
// `retry-after` parser and the same `throw { status, retryAfter,
// message }` block — three near-identical inlined duplicates.
//
// Keeping these in `runtime/` (not `routes/`) is deliberate: tests
// for the failover classifier already pull from `runtime/`, and the
// helpers don't depend on Fastify primitives.

/**
 * Parse a `Retry-After` header value into seconds.  HTTP allows both
 * an integer-seconds form and an HTTP-date form; we only support the
 * integer form (matches sub2api behaviour and what every observed
 * upstream actually sends).  Array values come from undici's headers
 * map when a server emits the header twice — pick the first value.
 *
 * @param raw  The raw header value (string, array, or undefined).
 * @returns    Seconds to wait before retry, or undefined if absent /
 *             unparseable.
 */
export function parseRetryAfterHeader(
  raw: string | string[] | undefined,
): number | undefined {
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val !== "string") return undefined;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Shape the failover loop expects when an attempt callback throws
 * a non-2xx upstream HTTP error.  The classifier inspects `status`
 * to decide retry-vs-fatal, optionally honours `retryAfter`, and
 * uses `message` for logging + the terminal `FatalUpstreamError`.
 */
export interface UpstreamHttpErrorThrow {
  status: number;
  retryAfter?: number;
  message: string;
}

/**
 * Build a `UpstreamHttpErrorThrow` from a non-streaming upstream
 * response.  Truncates the body to `messageMaxLen` bytes (default
 * 500) so a verbose 5xx body doesn't overflow logs.
 */
export function buildUpstreamHttpError(
  upstream: {
    status: number;
    body: Buffer;
    headers: Record<string, string | string[] | undefined>;
  },
  options: { messageMaxLen?: number } = {},
): UpstreamHttpErrorThrow {
  return {
    status: upstream.status,
    retryAfter: parseRetryAfterHeader(upstream.headers["retry-after"]),
    message: upstream.body.toString("utf8").slice(0, options.messageMaxLen ?? 500),
  };
}

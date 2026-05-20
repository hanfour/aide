// tRPC onError log-payload builder. Extracted from server.ts so the
// production-omits-input policy can be unit-tested without spinning up a
// full Fastify + tRPC adapter.
//
// Why this exists: tRPC mutations carry secrets in `input` (invite tokens,
// reveal tokens, future API-key flows). Pino redact paths catch
// known keys but cannot help if a new procedure adds a field name the
// redact list does not yet list. Dropping `input` entirely in production
// is the only way to guarantee no leak from unknown shapes.

export interface TrpcErrorLogArgs {
  error: { code: string; message: string; cause?: unknown };
  path?: string;
  input?: unknown;
}

export interface TrpcErrorLogPayload {
  path?: string;
  code: string;
  message: string;
  cause?: string;
  input?: unknown;
}

interface EnvLike {
  NODE_ENV?: string;
}

export function buildTrpcErrorLogPayload(
  args: TrpcErrorLogArgs,
  env: EnvLike,
): TrpcErrorLogPayload {
  const payload: TrpcErrorLogPayload = {
    path: args.path,
    code: args.error.code,
    message: args.error.message,
    cause:
      args.error.cause instanceof Error ? args.error.cause.message : undefined,
  };
  if (env.NODE_ENV !== "production") {
    payload.input = args.input;
  }
  return payload;
}

import type { ServerEnv } from "@aide/config";

// TODO(part-7): emit gw_redis_error_total counter (design 4.9 — adjacent to gw_redis_latency_seconds)

export class ServiceDegraded extends Error {
  readonly cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "ServiceDegraded";
    this.cause = cause;
  }
}

export type RedisFailureMode = ServerEnv["GATEWAY_REDIS_FAILURE_MODE"]; // "strict" | "lenient"

export interface WithRedisOptions {
  mode: RedisFailureMode;
  // Optional logger (pino-style: warn + error). If absent, errors are silent in lenient mode.
  logger?: { warn: (obj: unknown, msg?: string) => void };
  // Operation label for log context (e.g., "sticky:get", "slots:acquire")
  label?: string;
}

export async function withRedis<T>(
  opts: WithRedisOptions,
  op: () => Promise<T>,
  fallback: T | (() => T | Promise<T>),
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (opts.mode === "strict") {
      throw new ServiceDegraded(
        `redis op failed (${opts.label ?? "unknown"}): ${error.message}`,
        error,
      );
    }
    // lenient: log warn + return fallback
    opts.logger?.warn(
      { err: error.message, label: opts.label },
      "redis op failed; serving fallback (lenient mode)",
    );
    return typeof fallback === "function"
      ? await (fallback as () => T | Promise<T>)()
      : fallback;
  }
}

import Fastify, { type FastifyInstance } from "fastify";
import { parseServerEnv, type ServerEnv } from "@aide/config";
import type { Database } from "@aide/db";
import type { Redis } from "ioredis";
import { metricsPlugin } from "./plugins/metrics.js";
import { dbPlugin } from "./plugins/db.js";
import { redisPlugin } from "./redis/client.js";
import { apiKeyAuthPlugin } from "./middleware/apiKeyAuth.js";
import { messagesRoutes } from "./routes/messages.js";

export interface BuildOpts {
  env: ServerEnv;
  /** Optional test injection — passed straight through to dbPlugin. */
  db?: Database;
  /** Optional test injection — passed straight through to redisPlugin. */
  redis?: Redis;
}

export async function buildServer(opts: BuildOpts): Promise<FastifyInstance> {
  const enabled = opts.env.ENABLE_GATEWAY;
  const app = Fastify({
    logger: { level: opts.env.LOG_LEVEL },
    bodyLimit: opts.env.GATEWAY_MAX_BODY_BYTES,
  });
  await app.register(metricsPlugin);
  app.get("/health", async () =>
    enabled ? { status: "ok" } : { status: "disabled" },
  );
  if (!enabled) {
    app.log.warn("ENABLE_GATEWAY=false, gateway serves /health only");
    return app;
  }
  await app.register(dbPlugin, { env: opts.env, db: opts.db });
  await app.register(redisPlugin, { env: opts.env, client: opts.redis });
  await app.register(apiKeyAuthPlugin, { env: opts.env });
  await app.register(messagesRoutes, { env: opts.env });
  return app;
}

async function main() {
  const env = parseServerEnv(process.env);
  const app = await buildServer({ env });
  const port = env.GATEWAY_PORT;
  await app.listen({ port, host: "0.0.0.0" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

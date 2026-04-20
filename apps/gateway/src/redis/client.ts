import fp from "fastify-plugin";
import { Redis, type RedisOptions } from "ioredis";
import type { ServerEnv } from "@aide/config";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

export interface RedisPluginOptions {
  env: ServerEnv;
  /** Optional override for tests — inject ioredis-mock */
  client?: Redis;
}

export const redisPlugin = fp<RedisPluginOptions>(async (fastify, opts) => {
  if (!opts.client && !opts.env.REDIS_URL) {
    throw new Error("REDIS_URL required when gateway is enabled");
  }

  const redisOptions: RedisOptions = {
    enableAutoPipelining: true,
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  };

  const client: Redis = opts.client ?? new Redis(opts.env.REDIS_URL!, redisOptions);

  client.on("reconnecting", (delayMs: number) => {
    fastify.log.warn({ delayMs }, "redis reconnecting");
  });

  client.on("error", (err: Error) => {
    fastify.log.warn({ err: err.message }, "redis error");
  });

  fastify.addHook("onClose", async () => {
    await client.quit().catch(() => {
      // ioredis throws if already closed; ignore
    });
  });

  fastify.decorate("redis", client);
});

import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { Redis } from "ioredis";
import { parseServerEnv } from "@aide/config/env";
import { healthRoutes } from "./rest/health.js";
import { cookiesPlugin } from "./plugins/cookies.js";
import { authPlugin } from "./plugins/auth.js";
import { appRouter } from "./trpc/router.js";
import { createContextFactory } from "./trpc/context.js";

// When the gateway is disabled, no router actually reaches Redis (every
// gateway-aware router short-circuits to NOT_FOUND via ensureGatewayEnabled).
// We still need to satisfy the TrpcContext.redis type, so we hand back a proxy
// that throws loudly if any method is invoked. This means a regression that
// removes the ENABLE_GATEWAY guard would surface immediately at runtime
// instead of silently corrupting state.
function makeDisabledRedis(): Redis {
  const handler: ProxyHandler<Redis> = {
    get(_target, prop) {
      throw new Error(
        `redis disabled (ENABLE_GATEWAY=false); attempted access: ${String(
          prop,
        )}`,
      );
    },
  };
  return new Proxy({} as Redis, handler);
}

export async function buildServer() {
  const env = parseServerEnv();
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
    },
    disableRequestLogging: false,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(cookiesPlugin);
  await app.register(authPlugin, { env });
  await app.register(healthRoutes);

  // Dynamically load /test-seed only when all gating conditions hold. This
  // lets production images strip dist/rest/testSeed.js entirely — defense in
  // depth on top of the env + token checks inside the plugin itself.
  if (
    env.NODE_ENV !== "production" &&
    env.ENABLE_TEST_SEED === true &&
    !!env.TEST_SEED_TOKEN
  ) {
    const { testSeedRoutes } = await import("./rest/testSeed.js");
    await app.register(testSeedRoutes(env));
  }

  // Share the gateway's `aide:gw:` namespace so admin-issued api-key reveal
  // tokens stashed by the api land in the same keyspace the gateway can see.
  // env.REDIS_URL is required at parse time when ENABLE_GATEWAY=true.
  let redis: Redis;
  if (env.ENABLE_GATEWAY) {
    redis = new Redis(env.REDIS_URL!, {
      enableAutoPipelining: true,
      maxRetriesPerRequest: 3,
      keyPrefix: "aide:gw:",
    });
    redis.on("error", (err: Error) => {
      app.log.warn({ err: err.message }, "redis error");
    });
    app.addHook("onClose", async () => {
      await redis.quit().catch(() => {});
    });
  } else {
    redis = makeDisabledRedis();
  }

  // /trpc with rate limit 600/min/user (fall back to IP if no user)
  await app.register(
    async (scope) => {
      await scope.register(rateLimit, {
        max: 600,
        timeWindow: "1 minute",
        keyGenerator: (req) => req.user?.id ?? req.ip,
      });
      await scope.register(fastifyTRPCPlugin, {
        prefix: "",
        trpcOptions: {
          router: appRouter,
          createContext: createContextFactory({ env, redis }),
        },
      });
    },
    { prefix: "/trpc" },
  );

  return app;
}

async function main() {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

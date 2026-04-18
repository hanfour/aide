import Fastify from 'fastify'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { parseServerEnv } from '@aide/config/env'
import { healthRoutes } from './rest/health.js'
import { cookiesPlugin } from './plugins/cookies.js'
import { authPlugin } from './plugins/auth.js'
import { appRouter } from './trpc/router.js'
import { createContext } from './trpc/context.js'

export async function buildServer() {
  const env = parseServerEnv()
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' }
    },
    disableRequestLogging: false,
    genReqId: () => crypto.randomUUID()
  })

  await app.register(cookiesPlugin)
  await app.register(authPlugin, { env })
  await app.register(healthRoutes)
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext
    }
  })

  return app
}

async function main() {
  const app = await buildServer()
  const port = Number(process.env.PORT ?? 3001)
  await app.listen({ port, host: '0.0.0.0' })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

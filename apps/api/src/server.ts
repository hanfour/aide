import Fastify from 'fastify'
import { healthRoutes } from './rest/health.js'

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty' }
    },
    disableRequestLogging: false,
    genReqId: () => crypto.randomUUID()
  })

  await app.register(healthRoutes)
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

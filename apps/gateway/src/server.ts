import Fastify, { type FastifyInstance } from 'fastify'
import { metricsPlugin } from './plugins/metrics.js'

export interface BuildOpts { enabled: boolean }

export async function buildServer(opts: BuildOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })
  await app.register(metricsPlugin)
  app.get('/health', async () => opts.enabled
    ? { status: 'ok' }
    : { status: 'disabled' })
  if (!opts.enabled) {
    app.log.warn('ENABLE_GATEWAY=false, gateway serves /health only')
    return app
  }
  // Register /v1/* routes later (tasks in Part 5+)
  return app
}

async function main() {
  const enabled = process.env.ENABLE_GATEWAY === 'true'
  const app = await buildServer({ enabled })
  const port = Number(process.env.GATEWAY_PORT ?? 3002)
  await app.listen({ port, host: '0.0.0.0' })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1) })
}

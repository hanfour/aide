import Fastify, { type FastifyInstance } from 'fastify'
import { parseServerEnv, type ServerEnv } from '@aide/config'
import { metricsPlugin } from './plugins/metrics.js'

export interface BuildOpts { env: ServerEnv }

export async function buildServer(opts: BuildOpts): Promise<FastifyInstance> {
  const enabled = opts.env.ENABLE_GATEWAY
  const app = Fastify({ logger: { level: opts.env.LOG_LEVEL } })
  await app.register(metricsPlugin)
  app.get('/health', async () => enabled
    ? { status: 'ok' }
    : { status: 'disabled' })
  if (!enabled) {
    app.log.warn('ENABLE_GATEWAY=false, gateway serves /health only')
    return app
  }
  // Register /v1/* routes later (tasks in Part 5+)
  return app
}

async function main() {
  const env = parseServerEnv(process.env)
  const app = await buildServer({ env })
  const port = env.GATEWAY_PORT
  await app.listen({ port, host: '0.0.0.0' })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1) })
}

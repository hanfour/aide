import type { FastifyPluginAsync } from 'fastify'

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async () => ({
    status: 'ok',
    version: process.env.npm_package_version ?? 'dev',
    db: 'unchecked'
  }))

  fastify.get('/health/ready', async (_req, reply) => {
    reply.code(200)
    return { status: 'ready' }
  })
}

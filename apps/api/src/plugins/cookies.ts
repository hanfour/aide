import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import fastifyCookie from '@fastify/cookie'

export const cookiesPlugin: FastifyPluginAsync = fp(async (fastify) => {
  await fastify.register(fastifyCookie, {
    parseOptions: { sameSite: 'lax', httpOnly: true }
  })
})

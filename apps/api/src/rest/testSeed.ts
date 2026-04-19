import type { FastifyPluginAsync } from 'fastify'
import { sql } from 'drizzle-orm'
import {
  organizations,
  departments,
  teams,
  users,
  organizationMembers,
  teamMembers,
  roleAssignments,
  invites,
  auditLogs,
} from '@aide/db'
import type { ServerEnv } from '@aide/config/env'

export const testSeedRoutes = (env: ServerEnv): FastifyPluginAsync => async (fastify) => {
  const gatingActive =
    env.NODE_ENV !== 'production' && env.ENABLE_TEST_SEED === true && !!env.TEST_SEED_TOKEN

  if (!gatingActive) return

  fastify.post('/test-seed', async (req, reply) => {
    const header = req.headers['x-test-seed-token']
    if (typeof header !== 'string' || header !== env.TEST_SEED_TOKEN) {
      reply.code(403)
      return { error: 'forbidden' }
    }

    const db = fastify.db
    // Truncate all user-visible tables and RESTART IDENTITY on serial PKs
    await db.execute(sql`
      TRUNCATE TABLE
        ${auditLogs},
        ${invites},
        ${roleAssignments},
        ${teamMembers},
        ${organizationMembers},
        ${teams},
        ${departments},
        ${organizations},
        ${users}
      RESTART IDENTITY CASCADE
    `)

    return { ok: true, resetAt: new Date().toISOString() }
  })
}

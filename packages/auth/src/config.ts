import type { NextAuthConfig } from 'next-auth'
import type { Database } from '@aide/db'
import { organizations, organizationMembers, invites } from '@aide/db'
import { roleAssignments } from '@aide/db'
import { eq } from 'drizzle-orm'
import { buildProviders } from './providers.js'
import { makeAdapter } from './drizzle-adapter.js'
import { decideSignUp, type BootstrapConfig } from './bootstrap.js'

export interface AuthEnv extends BootstrapConfig {
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  AUTH_SECRET: string
}

export function buildAuthConfig(db: Database, env: AuthEnv): NextAuthConfig {
  return {
    adapter: makeAdapter(db),
    secret: env.AUTH_SECRET,
    session: { strategy: 'database', maxAge: 30 * 24 * 60 * 60 },
    providers: buildProviders(env),
    callbacks: {
      async signIn({ user }) {
        const email = user.email
        if (!email) return false
        const decision = await decideSignUp(db, email, env)
        return decision.allowed
      }
    },
    events: {
      async createUser({ user }) {
        if (!user.email || !user.id) return

        const decision = await decideSignUp(db, user.email, env)
        if (!decision.allowed) return

        if (decision.action === 'bootstrap') {
          const [org] = await db
            .insert(organizations)
            .values({ slug: env.defaultOrgSlug, name: env.defaultOrgName })
            .onConflictDoNothing()
            .returning()

          const resolvedOrg =
            org ??
            (await db.query.organizations.findFirst({
              where: eq(organizations.slug, env.defaultOrgSlug)
            }))

          if (resolvedOrg) {
            await db
              .insert(organizationMembers)
              .values({ orgId: resolvedOrg.id, userId: user.id })
              .onConflictDoNothing()
            await db.insert(roleAssignments).values({
              userId: user.id,
              role: 'super_admin',
              scopeType: 'global'
            })
          }
        } else if (decision.action === 'invite') {
          await db
            .insert(organizationMembers)
            .values({ orgId: decision.orgId, userId: user.id })
            .onConflictDoNothing()
          const inv = await db.query.invites.findFirst({ where: eq(invites.id, decision.inviteId) })
          if (inv) {
            await db.insert(roleAssignments).values({
              userId: user.id,
              role: inv.role,
              scopeType: inv.scopeType,
              scopeId: inv.scopeId
            })
            await db
              .update(invites)
              .set({ acceptedAt: new Date() })
              .where(eq(invites.id, inv.id))
          }
        }
      }
    },
    pages: { signIn: '/sign-in' }
  }
}

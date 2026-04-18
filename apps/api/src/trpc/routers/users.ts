import { z } from 'zod'
import { and, eq, ilike, inArray, type SQL } from 'drizzle-orm'
import { users, teamMembers, organizationMembers, teams } from '@aide/db'
import type { Database } from '@aide/db'
import { TRPCError } from '@trpc/server'
import type { UserPermissions } from '@aide/auth'
import { protectedProcedure, router } from '../procedures.js'

const uuid = z.string().uuid()

// Returns true if the actor is allowed to read target via spec §5.1 user.read:
// - super_admin: all
// - shared covered team (team_manager / dept_manager / org_admin through team)
// - shared covered org (org_admin / dept_manager path)
async function targetShareScope(
  db: Database,
  perm: UserPermissions,
  targetUserId: string
): Promise<boolean> {
  if (perm.rolesAtGlobal.has('super_admin')) return true

  const teamIds = [...perm.coveredTeams]
  if (teamIds.length > 0) {
    const shared = await db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(
        and(eq(teamMembers.userId, targetUserId), inArray(teamMembers.teamId, teamIds))
      )
      .limit(1)
    if (shared.length > 0) return true
  }

  const orgIds = [...perm.coveredOrgs]
  if (orgIds.length > 0) {
    const sharedOrg = await db
      .select({ orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, targetUserId),
          inArray(organizationMembers.orgId, orgIds)
        )
      )
      .limit(1)
    if (sharedOrg.length > 0) return true
  }

  return false
}

export const usersRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        orgId: uuid.optional(),
        teamId: uuid.optional(),
        search: z.string().max(255).optional()
      })
    )
    .query(async ({ ctx, input }) => {
      const extraConds: SQL[] = []
      if (input.search) extraConds.push(ilike(users.email, `%${input.search}%`))

      if (input.teamId) {
        if (!ctx.perm.coveredTeams.has(input.teamId)) {
          throw new TRPCError({ code: 'FORBIDDEN' })
        }
        const rows = await ctx.db
          .select({ user: users })
          .from(teamMembers)
          .innerJoin(users, eq(users.id, teamMembers.userId))
          .where(and(eq(teamMembers.teamId, input.teamId), ...extraConds))
        return rows.map((r) => r.user)
      }

      if (input.orgId) {
        // Scope coverage alone is NOT enough. Require at least a management
        // role somewhere: super_admin globally, org_admin on this org, or
        // dept_manager/team_manager (they can see members of teams they
        // manage within this org).
        const isSuperAdmin = ctx.perm.rolesAtGlobal.has('super_admin')
        const isOrgAdmin = ctx.perm.rolesByOrg.get(input.orgId)?.has('org_admin') ?? false
        const hasDeptOrTeamRole =
          [...ctx.perm.rolesByDept.values()].some((s) => s.has('dept_manager')) ||
          [...ctx.perm.rolesByTeam.values()].some((s) => s.has('team_manager'))
        if (!isSuperAdmin && !isOrgAdmin && !hasDeptOrTeamRole) {
          throw new TRPCError({ code: 'FORBIDDEN' })
        }

        const rows = await ctx.db
          .select({ user: users })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(and(eq(organizationMembers.orgId, input.orgId), ...extraConds))

        // super_admin / org_admin: full org roster.
        if (isSuperAdmin || isOrgAdmin) return rows.map((r) => r.user)

        // dept_manager / team_manager: filter to users on their covered teams
        // that live inside this org.
        const teamIds = [...ctx.perm.coveredTeams]
        if (teamIds.length === 0) return []
        const visible = await ctx.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .innerJoin(teams, eq(teams.id, teamMembers.teamId))
          .where(and(eq(teams.orgId, input.orgId), inArray(teamMembers.teamId, teamIds)))
        const allow = new Set(visible.map((v) => v.userId))
        return rows.filter((r) => allow.has(r.user.id)).map((r) => r.user)
      }

      // no scope: self only
      return ctx.db.select().from(users).where(eq(users.id, ctx.user.id))
    }),

  get: protectedProcedure
    .input(z.object({ id: uuid }))
    .query(async ({ ctx, input }) => {
      if (input.id !== ctx.user.id) {
        const ok = await targetShareScope(ctx.db, ctx.perm, input.id)
        if (!ok) throw new TRPCError({ code: 'FORBIDDEN' })
      }
      const [row] = await ctx.db.select().from(users).where(eq(users.id, input.id)).limit(1)
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      return row
    })
})

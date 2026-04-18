import { z } from 'zod'
import { and, eq, ilike, inArray, type SQL } from 'drizzle-orm'
import { users, teamMembers, organizationMembers } from '@aide/db'
import { TRPCError } from '@trpc/server'
import { protectedProcedure, router } from '../procedures.js'

const uuid = z.string().uuid()

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
        if (!ctx.perm.coveredOrgs.has(input.orgId)) {
          throw new TRPCError({ code: 'FORBIDDEN' })
        }
        const rows = await ctx.db
          .select({ user: users })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(and(eq(organizationMembers.orgId, input.orgId), ...extraConds))
        return rows.map((r) => r.user)
      }
      // no scope: only self
      return ctx.db.select().from(users).where(eq(users.id, ctx.user.id))
    }),

  get: protectedProcedure
    .input(z.object({ id: uuid }))
    .query(async ({ ctx, input }) => {
      if (input.id !== ctx.user.id) {
        // non-self: must share a covered team
        const teamIds = [...ctx.perm.coveredTeams]
        if (teamIds.length === 0) throw new TRPCError({ code: 'FORBIDDEN' })
        const shared = await ctx.db
          .select({ teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(
            and(eq(teamMembers.userId, input.id), inArray(teamMembers.teamId, teamIds))
          )
          .limit(1)
        if (shared.length === 0) throw new TRPCError({ code: 'FORBIDDEN' })
      }
      const [row] = await ctx.db.select().from(users).where(eq(users.id, input.id)).limit(1)
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      return row
    })
})

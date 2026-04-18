import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { users } from '@aide/db'
import { protectedProcedure, router } from '../procedures.js'

export const meRouter = router({
  session: protectedProcedure.query(({ ctx }) => ({
    user: ctx.user,
    assignments: ctx.perm.assignments,
    coveredOrgs: [...ctx.perm.coveredOrgs],
    coveredDepts: [...ctx.perm.coveredDepts],
    coveredTeams: [...ctx.perm.coveredTeams]
  })),
  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255).optional(),
        image: z.string().url().max(1024).optional()
      })
    )
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = {}
      if (input.name !== undefined) patch.name = input.name
      if (input.image !== undefined) patch.image = input.image
      const [row] = await ctx.db
        .update(users)
        .set(patch)
        .where(eq(users.id, ctx.user.id))
        .returning()
      return row
    })
})

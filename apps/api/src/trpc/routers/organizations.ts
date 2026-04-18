import { z } from 'zod'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { organizations } from '@aide/db'
import { TRPCError } from '@trpc/server'
import {
  protectedProcedure,
  permissionProcedure,
  router
} from '../procedures.js'

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/)
const uuid = z.string().uuid()

export const organizationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const ids = [...ctx.perm.coveredOrgs]
    if (ids.length === 0) return []
    return ctx.db
      .select()
      .from(organizations)
      .where(and(inArray(organizations.id, ids), isNull(organizations.deletedAt)))
  }),

  get: permissionProcedure(z.object({ id: uuid }), (_, input) => ({
    type: 'org.read',
    orgId: input.id
  })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, input.id), isNull(organizations.deletedAt)))
      .limit(1)
    if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
    return row
  }),

  create: protectedProcedure
    .input(z.object({ slug, name: z.string().min(1).max(255) }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.perm.rolesAtGlobal.has('super_admin')) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      const [row] = await ctx.db.insert(organizations).values(input).returning()
      return row
    }),

  update: permissionProcedure(
    z.object({ id: uuid, name: z.string().min(1).max(255) }),
    (_, input) => ({ type: 'org.update', orgId: input.id })
  ).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .update(organizations)
      .set({ name: input.name })
      .where(eq(organizations.id, input.id))
      .returning()
    if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
    return row
  }),

  delete: protectedProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.perm.rolesAtGlobal.has('super_admin')) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      const [row] = await ctx.db
        .update(organizations)
        .set({ deletedAt: new Date() })
        .where(eq(organizations.id, input.id))
        .returning({ id: organizations.id })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      return { id: row.id }
    })
})

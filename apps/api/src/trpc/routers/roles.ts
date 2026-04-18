import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import { roleAssignments, users } from '@aide/db'
import { TRPCError } from '@trpc/server'
import {
  protectedProcedure,
  permissionProcedure,
  router
} from '../procedures.js'
import { grantRole, revokeRole } from '../../services/roles.js'
import { mapServiceError } from '../errors.js'

const uuid = z.string().uuid()
const roleEnum = z.enum([
  'super_admin',
  'org_admin',
  'dept_manager',
  'team_manager',
  'member'
])
const scopeEnum = z.enum(['global', 'organization', 'department', 'team'])

export const rolesRouter = router({
  grant: permissionProcedure(
    z.object({
      userId: uuid,
      role: roleEnum,
      scopeType: scopeEnum,
      scopeId: uuid.nullable()
    }),
    (_, input) => ({
      type: 'role.grant',
      targetUserId: input.userId,
      role: input.role,
      scopeType: input.scopeType,
      scopeId: input.scopeId
    })
  ).mutation(async ({ ctx, input }) => {
    // verify target user exists so we don't surface raw FK violation to the client
    const [existing] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'target user not found' })
    return grantRole(ctx.db, ctx.user.id, input)
  }),

  revoke: permissionProcedure(
    z.object({ assignmentId: uuid }),
    () => ({ type: 'role.revoke', assignmentOwnerId: 'unused' })
  ).mutation(async ({ ctx, input }) => {
    try {
      return await revokeRole(ctx.db, input.assignmentId)
    } catch (e) {
      throw mapServiceError(e)
    }
  }),

  listForUser: protectedProcedure
    .input(z.object({ userId: uuid }))
    .query(async ({ ctx, input }) => {
      if (input.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      return ctx.db
        .select()
        .from(roleAssignments)
        .where(and(eq(roleAssignments.userId, input.userId), isNull(roleAssignments.revokedAt)))
    })
})

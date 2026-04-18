import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from '@aide/db'
import { roleAssignments } from '@aide/db'
import type { Role, ScopeType } from '@aide/auth'
import { ServiceError } from '../trpc/errors.js'

export async function grantRole(
  db: Database,
  grantedBy: string,
  input: { userId: string; role: Role; scopeType: ScopeType; scopeId: string | null }
) {
  const [row] = await db
    .insert(roleAssignments)
    .values({
      userId: input.userId,
      role: input.role,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      grantedBy
    })
    .returning()
  return row
}

export async function revokeRole(db: Database, assignmentId: string) {
  const [row] = await db
    .update(roleAssignments)
    .set({ revokedAt: new Date() })
    .where(and(eq(roleAssignments.id, assignmentId), isNull(roleAssignments.revokedAt)))
    .returning({ id: roleAssignments.id })
  if (!row) throw new ServiceError('NOT_FOUND', 'assignment not found or already revoked')
  return { id: row.id }
}

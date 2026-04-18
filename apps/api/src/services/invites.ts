import { randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Database } from '@aide/db'
import { invites, organizationMembers, roleAssignments } from '@aide/db'
import type { Role, ScopeType } from '@aide/auth'
import { ServiceError } from '../trpc/errors.js'

function newToken() {
  return randomBytes(32).toString('base64url')
}

export async function createInvite(
  db: Database,
  inviter: { id: string },
  input: {
    orgId: string
    email: string
    role: Role
    scopeType: ScopeType
    scopeId: string | null
  }
) {
  try {
    const [row] = await db
      .insert(invites)
      .values({
        orgId: input.orgId,
        email: input.email,
        role: input.role,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        invitedBy: inviter.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        token: newToken()
      })
      .returning()
    if (!row) throw new ServiceError('CONFLICT', 'invite already exists')
    return row
  } catch (err) {
    // Postgres unique_violation → surface as CONFLICT so router maps to 409.
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      throw new ServiceError('CONFLICT', 'invite already exists')
    }
    throw err
  }
}

export async function revokeInvite(db: Database, id: string) {
  // DELETE rather than tombstone — invites has UNIQUE(org_id, email) so leaving
  // a dead row would block re-inviting the same email. Audit log preserves
  // history of the revoke action.
  const [row] = await db
    .delete(invites)
    .where(and(eq(invites.id, id), isNull(invites.acceptedAt)))
    .returning({ id: invites.id })
  if (!row) throw new ServiceError('NOT_FOUND', 'invite not found or already used')
  return { id: row.id }
}

export async function acceptInvite(
  db: Database,
  actor: { id: string; email: string },
  token: string
) {
  // Wrap in a transaction with SELECT … FOR UPDATE to prevent concurrent
  // accepts from creating duplicate role_assignments. Drizzle's builder-level
  // `.for('update')` lock compiles cleanly and avoids raw-sql driver quirks.
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.token, token),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, new Date())
        )
      )
      .limit(1)
      .for('update')
    if (!invite) throw new ServiceError('NOT_FOUND', 'invalid or expired invite')
    if (invite.email.toLowerCase() !== actor.email.toLowerCase()) {
      throw new ServiceError('FORBIDDEN', 'invite email does not match')
    }
    await tx
      .insert(organizationMembers)
      .values({ orgId: invite.orgId, userId: actor.id })
      .onConflictDoNothing()
    await tx.insert(roleAssignments).values({
      userId: actor.id,
      role: invite.role,
      scopeType: invite.scopeType,
      scopeId: invite.scopeId
    })
    await tx
      .update(invites)
      .set({ acceptedAt: new Date() })
      .where(eq(invites.id, invite.id))
    return { orgId: invite.orgId }
  })
}

import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Database } from '@aide/db'
import type { UserPermissions } from '@aide/auth'

export interface TrpcContext {
  db: Database
  user: { id: string; email: string } | null
  perm: UserPermissions | null
  reqId: string
}

export async function createContext(opts: {
  req: FastifyRequest
  res: FastifyReply
}): Promise<TrpcContext> {
  return {
    db: opts.req.server.db,
    user: opts.req.user,
    perm: opts.req.perm,
    reqId: opts.req.id
  }
}

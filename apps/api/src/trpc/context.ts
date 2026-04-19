import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "@aide/db";
import type { UserPermissions } from "@aide/auth";

// Fastify module augmentation for decorators set up by the api plugins.
// Declared here (in addition to plugins/auth.ts) so that downstream consumers
// of `@aide/api/trpc` — which only import this file's type graph — pick it up.
declare module "fastify" {
  interface FastifyRequest {
    user: { id: string; email: string } | null;
    perm: UserPermissions | null;
  }
  interface FastifyInstance {
    db: Database;
  }
}

export interface TrpcContext {
  db: Database;
  user: { id: string; email: string } | null;
  perm: UserPermissions | null;
  reqId: string;
}

export async function createContext(opts: {
  req: FastifyRequest;
  res: FastifyReply;
}): Promise<TrpcContext> {
  return {
    db: opts.req.server.db,
    user: opts.req.user,
    perm: opts.req.perm,
    reqId: opts.req.id,
  };
}

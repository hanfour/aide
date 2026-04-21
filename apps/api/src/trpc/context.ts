import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Database } from "@aide/db";
import type { UserPermissions } from "@aide/auth";
import type { ServerEnv } from "@aide/config";

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
  env: ServerEnv;
  // Shared with the gateway via the `aide:gw:` keyPrefix so admin-issued
  // api-key reveal-token stashes are written/read from the same namespace.
  // When ENABLE_GATEWAY=false, this is a placeholder client whose methods
  // throw on use — the routers' ENABLE_GATEWAY guard short-circuits before
  // any redis call is reached.
  redis: Redis;
  // Source IP of the inbound request, used for audit fields (e.g.
  // api_keys.revealed_by_ip). Null when the caller is created outside an
  // HTTP request (e.g. the test harness).
  ipAddress: string | null;
}

export interface CreateContextDeps {
  env: ServerEnv;
  redis: Redis;
}

// Factory: bind the parsed env + shared redis client at server-startup time,
// then return the actual createContext callback that fastify-trpc will invoke
// per request. This avoids re-parsing env / re-allocating clients on every
// request.
export function createContextFactory(deps: CreateContextDeps) {
  return async function createContext(opts: {
    req: FastifyRequest;
    res: FastifyReply;
  }): Promise<TrpcContext> {
    return {
      db: opts.req.server.db,
      user: opts.req.user,
      perm: opts.req.perm,
      reqId: opts.req.id,
      env: deps.env,
      redis: deps.redis,
      ipAddress: opts.req.ip ?? null,
    };
  };
}

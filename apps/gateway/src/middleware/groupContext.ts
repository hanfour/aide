// Fastify preHandler that resolves the AccountGroup for the
// authenticated request and attaches it to `req.gwGroupContext`
// (Plan 5A Part 8, Task 8.2).
//
// Ordering: must register AFTER `apiKeyAuthPlugin` so `req.apiKey` is
// populated. Public paths and unauthenticated requests are skipped —
// `req.apiKey == null` after apiKeyAuth means either /health, /metrics,
// or auth already 401'd, so there's nothing to resolve.

import fp from "fastify-plugin";
import {
  resolveGroupContext,
  type GroupContext,
} from "../runtime/groupDispatch.js";

declare module "fastify" {
  interface FastifyRequest {
    gwGroupContext: GroupContext | null;
  }
}

export const groupContextPlugin = fp(async (fastify) => {
  fastify.decorateRequest("gwGroupContext", null);

  fastify.addHook("preHandler", async (req, reply) => {
    if (!req.apiKey) return; // public path or already-failed auth

    const ctx = await resolveGroupContext(fastify.db, {
      orgId: req.apiKey.orgId,
      groupId: req.apiKey.groupId,
    });
    if (!ctx) {
      reply.code(403).send({ error: "group_not_found_or_disabled" });
      return reply;
    }
    req.gwGroupContext = ctx;
  });
});

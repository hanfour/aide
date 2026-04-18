import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import { createDb, sessions, users } from "@aide/db";
import { resolvePermissions, type UserPermissions } from "@aide/auth";
import type { ServerEnv } from "@aide/config";

declare module "fastify" {
  interface FastifyRequest {
    user: { id: string; email: string } | null;
    perm: UserPermissions | null;
  }
  interface FastifyInstance {
    db: ReturnType<typeof createDb>["db"];
  }
}

export interface AuthPluginOptions {
  env: ServerEnv;
}

export const authPlugin = fp<AuthPluginOptions>(async (fastify, opts) => {
  const { db, pool } = createDb(opts.env.DATABASE_URL);
  fastify.addHook("onClose", async () => {
    await pool.end();
  });
  fastify.decorateRequest("user", null);
  fastify.decorateRequest("perm", null);
  fastify.decorate("db", db);

  const cookieName =
    opts.env.NODE_ENV === "production"
      ? "__Secure-authjs.session-token"
      : "authjs.session-token";

  fastify.addHook("onRequest", async (req) => {
    const token = req.cookies[cookieName];
    if (!token) return;

    const row = await db
      .select({
        userId: sessions.userId,
        expires: sessions.expires,
        email: users.email,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.sessionToken, token))
      .limit(1)
      .then((r) => r[0]);

    if (row && row.expires > new Date()) {
      req.user = { id: row.userId, email: row.email };
      req.perm = await resolvePermissions(db, row.userId);
    }
  });
});

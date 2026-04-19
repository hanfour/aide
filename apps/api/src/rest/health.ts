import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async () => {
    let dbStatus: "up" | "down" = "down";
    try {
      await fastify.db.execute(sql`select 1`);
      dbStatus = "up";
    } catch {
      dbStatus = "down";
    }
    return {
      status: dbStatus === "up" ? "ok" : "degraded",
      version: process.env.npm_package_version ?? "dev",
      db: dbStatus,
    };
  });

  fastify.get("/health/ready", async (_req, reply) => {
    try {
      await fastify.db.execute(sql`select 1`);
      // Drizzle's node-postgres migrator records applied migrations in
      // drizzle.__drizzle_migrations. If the row count is ≥1, at least
      // the first migration ran — enough to consider the service ready.
      const rows = await fastify.db.execute<{ count: string }>(
        sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
      );
      const applied = Number(rows.rows[0]?.count ?? 0);
      if (applied < 1) {
        reply.code(503);
        return { status: "not_ready", reason: "migrations_pending" };
      }
      reply.code(200);
      return { status: "ready", migrations: applied };
    } catch (err) {
      reply.code(503);
      return {
        status: "not_ready",
        reason: err instanceof Error ? err.message : "db_unreachable",
      };
    }
  });
};

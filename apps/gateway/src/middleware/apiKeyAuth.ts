import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import ipaddr from "ipaddr.js";
import { hashApiKey } from "@aide/gateway-core";
import { apiKeys, users, organizations } from "@aide/db";
import type { Database } from "@aide/db";
import type { ServerEnv } from "@aide/config";

declare module "fastify" {
  interface FastifyRequest {
    apiKey: {
      id: string;
      orgId: string;
      userId: string;
      teamId: string | null;
      quotaUsd: string;
      quotaUsedUsd: string;
    } | null;
    gwUser: { id: string; email: string } | null;
    gwOrg: { id: string; slug: string } | null;
  }
  interface FastifyInstance {
    db: Database;
  }
}

export interface ApiKeyAuthOptions {
  env: ServerEnv;
}

export const apiKeyAuthPlugin = fp<ApiKeyAuthOptions>(async (fastify, opts) => {
  fastify.decorateRequest("apiKey", null);
  fastify.decorateRequest("gwUser", null);
  fastify.decorateRequest("gwOrg", null);

  fastify.addHook("preHandler", async (req, reply) => {
    if (req.url === "/health" || req.url === "/metrics") return;

    const raw = extractKey(req.headers);
    if (!raw) {
      reply.code(401).send({ error: "missing_api_key" });
      return reply;
    }

    const pepper = opts.env.API_KEY_HASH_PEPPER;
    if (!pepper) {
      reply.code(500).send({ error: "server_misconfigured" });
      return reply;
    }
    const keyHash = hashApiKey(pepper, raw);

    const row = await fastify.db
      .select({
        apiKey: apiKeys,
        user: { id: users.id, email: users.email },
        org: { id: organizations.id, slug: organizations.slug },
      })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .innerJoin(organizations, eq(organizations.id, apiKeys.orgId))
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1)
      .then((r: Array<unknown>) => r[0] as RowResult | undefined);

    if (!row) {
      reply.code(401).send({ error: "key_invalid" });
      return reply;
    }

    if (row.apiKey.revokedAt !== null) {
      reply.code(401).send({ error: "key_revoked" });
      return reply;
    }

    if (row.apiKey.expiresAt !== null && row.apiKey.expiresAt <= new Date()) {
      reply.code(401).send({ error: "key_expired" });
      return reply;
    }

    if (row.apiKey.revealTokenHash !== null && row.apiKey.revealedAt === null) {
      reply.code(401).send({ error: "key_not_yet_revealed" });
      return reply;
    }

    const ip = req.ip;
    const blacklist = row.apiKey.ipBlacklist ?? [];
    const whitelist = row.apiKey.ipWhitelist ?? [];

    if (blacklist.length > 0 && matchesAny(ip, blacklist)) {
      reply.code(403).send({ error: "ip_not_allowed" });
      return reply;
    }

    if (whitelist.length > 0 && !matchesAny(ip, whitelist)) {
      reply.code(403).send({ error: "ip_not_allowed" });
      return reply;
    }

    req.apiKey = {
      id: row.apiKey.id,
      orgId: row.apiKey.orgId,
      userId: row.apiKey.userId,
      teamId: row.apiKey.teamId,
      quotaUsd: row.apiKey.quotaUsd,
      quotaUsedUsd: row.apiKey.quotaUsedUsd,
    };
    req.gwUser = row.user;
    req.gwOrg = row.org;
  });
});

interface ApiKeyRow {
  id: string;
  orgId: string;
  userId: string;
  teamId: string | null;
  keyHash: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  revealTokenHash: string | null;
  revealedAt: Date | null;
  ipWhitelist: string[] | null;
  ipBlacklist: string[] | null;
  quotaUsd: string;
  quotaUsedUsd: string;
}

interface RowResult {
  apiKey: ApiKeyRow;
  user: { id: string; email: string };
  org: { id: string; slug: string };
}

function extractKey(headers: Record<string, unknown>): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  const xKey = headers["x-api-key"];
  if (typeof xKey === "string" && xKey.length > 0) {
    return xKey;
  }
  return null;
}

function matchesAny(ip: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return false;
  try {
    const parsed = ipaddr.process(ip);
    return cidrs.some((c) => {
      try {
        const [addr, prefixStr] = c.split("/");
        const prefix = prefixStr
          ? Number(prefixStr)
          : parsed.kind() === "ipv6"
            ? 128
            : 32;
        return parsed.match(ipaddr.parseCIDR(`${addr}/${prefix}`));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

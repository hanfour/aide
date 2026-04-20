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

const PUBLIC_PATHS = new Set(["/health", "/metrics"]);

export const apiKeyAuthPlugin = fp<ApiKeyAuthOptions>(async (fastify, opts) => {
  fastify.decorateRequest("apiKey", null);
  fastify.decorateRequest("gwUser", null);
  fastify.decorateRequest("gwOrg", null);

  fastify.addHook("preHandler", async (req, reply) => {
    const path = (req.url ?? "").split("?", 1)[0] ?? "";
    if (PUBLIC_PATHS.has(path)) return;

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
      .then((r) => r[0]);

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

    // TODO(part-4+): wire GATEWAY_TRUSTED_PROXIES into Fastify trustProxy
    // (currently req.ip resolves from socket; all production traffic behind L7
    // proxies will appear to come from the proxy IP until this is hooked up).
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

function extractKey(headers: Record<string, unknown>): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xKey = headers["x-api-key"];
  if (typeof xKey === "string" && xKey.trim().length > 0) {
    return xKey.trim();
  }
  return null;
}

function matchesAny(ip: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return false;
  try {
    const parsed = ipaddr.process(ip);
    return cidrs.some((c) => {
      try {
        const cidr = c.includes("/")
          ? c
          : `${c}/${parsed.kind() === "ipv6" ? 128 : 32}`;
        return parsed.match(ipaddr.parseCIDR(cidr));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { apiKeys, organizationMembers } from "@aide/db";
import type { Database } from "@aide/db";
import { generateApiKey, hashApiKey } from "@aide/gateway-core";
import { can } from "@aide/auth";
import {
  protectedProcedure,
  permissionProcedure,
  router,
} from "../procedures.js";

const uuid = z.string().uuid();

// Reveal-token TTL — must match the Redis EX value below so the DB row's
// expiration window stays in lockstep with the cache stash.
const REVEAL_TOKEN_TTL_SEC = 24 * 60 * 60;

// Redis key suffix (the ioredis client prepends `aide:gw:` via keyPrefix).
function revealKey(token: string): string {
  return `key-reveal:${token}`;
}

function ensureGatewayEnabled(env: { ENABLE_GATEWAY: boolean }) {
  if (!env.ENABLE_GATEWAY) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

// Centralizes the API_KEY_HASH_PEPPER presence check. The env schema requires
// this when the gateway is enabled, so reaching the throw branch indicates a
// misconfiguration upstream — guard so we never call hashApiKey with undefined.
function requirePepper(env: { API_KEY_HASH_PEPPER?: string }): string {
  const pepper = env.API_KEY_HASH_PEPPER;
  if (!pepper) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "API_KEY_HASH_PEPPER not configured",
    });
  }
  return pepper;
}

function requireGatewayBaseUrl(env: { GATEWAY_BASE_URL?: string }): string {
  const url = env.GATEWAY_BASE_URL;
  if (!url) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "GATEWAY_BASE_URL not configured",
    });
  }
  return url;
}

// Generate a 32-byte URL-safe token. Used as the one-time secret in the admin
// reveal flow — the holder of this token can claim the raw key exactly once.
function generateRevealToken(): string {
  return randomBytes(32).toString("base64url");
}

// HMAC-SHA256 of the reveal token with the api-key pepper. We never store the
// token itself in the DB (that would defeat the one-time URL guarantee), only
// its HMAC so we can look up the row when the admin/user clicks the URL.
function hashRevealToken(pepperHex: string, token: string): string {
  if (!/^[0-9a-f]{64}$/i.test(pepperHex)) {
    throw new Error("pepper must be 32 bytes hex (64 chars)");
  }
  return createHmac("sha256", Buffer.from(pepperHex, "hex"))
    .update(token)
    .digest("hex");
}

// Resolve a user's primary org membership. Used by `issueOwn` where the
// org isn't part of the input (a regular member doesn't pass orgId — the
// system picks their canonical org). We pick the earliest-joined org for
// determinism. NOT_FOUND if the user belongs to no org (defense in depth;
// in production all real users should belong to at least one).
async function resolveUserPrimaryOrgId(
  db: Database,
  userId: string,
): Promise<string> {
  const [row] = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizationMembers.joinedAt))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "user has no organization membership",
    });
  }
  return row.orgId;
}

// Columns the API surfaces to non-admin callers. Excludes anything that
// could leak key material or expose internal reveal-flow bookkeeping.
const ownColumns = {
  id: apiKeys.id,
  prefix: apiKeys.keyPrefix,
  name: apiKeys.name,
  status: apiKeys.status,
  lastUsedAt: apiKeys.lastUsedAt,
  createdAt: apiKeys.createdAt,
  expiresAt: apiKeys.expiresAt,
  teamId: apiKeys.teamId,
  quotaUsd: apiKeys.quotaUsd,
  quotaUsedUsd: apiKeys.quotaUsedUsd,
} as const;

// Org-admin view adds ownership context (who owns the key, who issued it)
// but still excludes keyHash / revealTokenHash / revealedByIp.
const orgColumns = {
  ...ownColumns,
  userId: apiKeys.userId,
  issuedByUserId: apiKeys.issuedByUserId,
} as const;

export const apiKeysRouter = router({
  // Member-level: the caller issues a key for themselves. Returns the raw
  // key exactly once — the API never persists plaintext, only the HMAC.
  issueOwn: permissionProcedure(
    z.object({
      name: z.string().min(1).max(255),
      teamId: uuid.nullable().optional(),
    }),
    () => ({ type: "api_key.issue_own" }),
  ).mutation(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const pepper = requirePepper(ctx.env);
    const orgId = await resolveUserPrimaryOrgId(ctx.db, ctx.user.id);

    const { raw, prefix } = generateApiKey();
    const keyHash = hashApiKey(pepper, raw);

    const [row] = await ctx.db
      .insert(apiKeys)
      .values({
        userId: ctx.user.id,
        orgId,
        teamId: input.teamId ?? null,
        keyHash,
        keyPrefix: prefix,
        name: input.name,
        status: "active",
        issuedByUserId: null,
      })
      .returning({ id: apiKeys.id, prefix: apiKeys.keyPrefix });
    if (!row) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "failed to insert api_keys row",
      });
    }

    return { id: row.id, prefix: row.prefix, raw };
  }),

  // Org-admin issues a key for another user. The admin never sees the raw
  // value: a one-time reveal URL is returned which the target user can claim
  // exactly once within REVEAL_TOKEN_TTL_SEC. The raw is stashed in Redis
  // (under the gateway's `aide:gw:` namespace) keyed by the random token.
  issueForUser: permissionProcedure(
    z.object({
      orgId: uuid,
      targetUserId: uuid,
      name: z.string().min(1).max(255),
      teamId: uuid.nullable().optional(),
    }),
    (_, input) => ({
      type: "api_key.issue_for_user",
      orgId: input.orgId,
      targetUserId: input.targetUserId,
    }),
  ).mutation(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const pepper = requirePepper(ctx.env);
    const baseUrl = requireGatewayBaseUrl(ctx.env);

    const { raw, prefix } = generateApiKey();
    const keyHash = hashApiKey(pepper, raw);

    const token = generateRevealToken();
    const revealTokenHash = hashRevealToken(pepper, token);
    const revealTokenExpiresAt = new Date(
      Date.now() + REVEAL_TOKEN_TTL_SEC * 1000,
    );

    // Stash the raw in Redis FIRST. If the DB insert fails afterwards we'll
    // leave a 24h-TTL'd orphan in Redis, which is harmless (no DB row → the
    // reveal lookup can't find it). Doing it the other way (DB first) would
    // create a row whose raw can never be revealed if Redis is briefly down.
    await ctx.redis.set(revealKey(token), raw, "EX", REVEAL_TOKEN_TTL_SEC);

    const [row] = await ctx.db
      .insert(apiKeys)
      .values({
        userId: input.targetUserId,
        orgId: input.orgId,
        teamId: input.teamId ?? null,
        keyHash,
        keyPrefix: prefix,
        name: input.name,
        status: "active",
        issuedByUserId: ctx.user.id,
        revealTokenHash,
        revealTokenExpiresAt,
      })
      .returning({ id: apiKeys.id, prefix: apiKeys.keyPrefix });
    if (!row) {
      // Best-effort cleanup of the orphaned Redis stash; ignore errors.
      await ctx.redis.del(revealKey(token)).catch(() => {});
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "failed to insert api_keys row",
      });
    }

    return {
      id: row.id,
      prefix: row.prefix,
      revealUrl: `${baseUrl}/api-keys/reveal/${token}`,
    };
  }),

  // Claim the one-time reveal URL. Requires login AND that the caller is the
  // targetUser the key was issued for. The token is the secret; session
  // enforces ownership scope so a misdirected URL (admin sent it to the wrong
  // person) cannot be claimed by the wrong user. Single-use is enforced via
  // a CAS update on revealedAt. NOT_FOUND on userId mismatch — no existence
  // leak (the wrong recipient can't tell the token was valid for someone else).
  revealViaToken: protectedProcedure
    .input(z.object({ token: z.string().min(1).max(512) }))
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const pepper = requirePepper(ctx.env);
      const tokenHash = hashRevealToken(pepper, input.token);

      const [row] = await ctx.db
        .select({
          id: apiKeys.id,
          prefix: apiKeys.keyPrefix,
          name: apiKeys.name,
        })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.revealTokenHash, tokenHash),
            eq(apiKeys.userId, ctx.user.id),
            gt(apiKeys.revealTokenExpiresAt, sql`NOW()`),
            isNull(apiKeys.revealedAt),
            isNull(apiKeys.revokedAt),
          ),
        )
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });

      const raw = await ctx.redis.get(revealKey(input.token));
      if (!raw) {
        // Cache may have evicted earlier than the DB window allowed (e.g.
        // Redis restart). Surface as NOT_FOUND so we don't leak stash state.
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      // CAS: only the first claimant flips revealedAt. Without the
      // `revealedAt IS NULL` predicate two concurrent readers could both
      // succeed and claim the same token.
      const updated = await ctx.db
        .update(apiKeys)
        .set({
          revealedAt: sql`NOW()`,
          revealedByIp: ctx.ipAddress,
          updatedAt: sql`NOW()`,
        })
        .where(and(eq(apiKeys.id, row.id), isNull(apiKeys.revealedAt)))
        .returning({ id: apiKeys.id });
      if (updated.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "token already revealed",
        });
      }

      // Best-effort: drop the stash so the URL can't even hit the cache
      // again. The CAS above is the authoritative single-use guard.
      await ctx.redis.del(revealKey(input.token)).catch(() => {});

      return { id: row.id, prefix: row.prefix, raw, name: row.name };
    }),

  // Member-level: list the caller's own active keys. Excludes anything
  // soft-revoked (revokedAt IS NOT NULL). No key material in the response.
  listOwn: permissionProcedure(z.object({}).optional(), () => ({
    type: "api_key.list_own",
  })).query(async ({ ctx }) => {
    ensureGatewayEnabled(ctx.env);
    const rows = await ctx.db
      .select(ownColumns)
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, ctx.user.id), isNull(apiKeys.revokedAt)));
    return rows;
  }),

  // Org-admin only: list every active key in the org. Used by admin UIs to
  // audit/rotate user-issued credentials.
  listOrg: permissionProcedure(z.object({ orgId: uuid }), (_, input) => ({
    type: "api_key.list_all",
    orgId: input.orgId,
  })).query(async ({ ctx, input }) => {
    ensureGatewayEnabled(ctx.env);
    const rows = await ctx.db
      .select(orgColumns)
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, input.orgId), isNull(apiKeys.revokedAt)));
    return rows;
  }),

  // Soft-revoke a key. The RBAC action carries the key's owner + org so the
  // permission layer can decide whether the caller is allowed (self-revoke
  // for the owner; org_admin for org-wide revoke). NOT_FOUND covers both
  // missing and already-revoked rows so we never leak existence.
  revoke: protectedProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ ctx, input }) => {
      ensureGatewayEnabled(ctx.env);
      const [existing] = await ctx.db
        .select({
          id: apiKeys.id,
          orgId: apiKeys.orgId,
          ownerUserId: apiKeys.userId,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.id, input.id))
        .limit(1);
      if (!existing || existing.revokedAt !== null) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (
        !can(ctx.perm, {
          type: "api_key.revoke",
          apiKeyId: existing.id,
          orgId: existing.orgId,
          ownerUserId: existing.ownerUserId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const updated = await ctx.db
        .update(apiKeys)
        .set({ revokedAt: sql`NOW()`, updatedAt: sql`NOW()` })
        .where(and(eq(apiKeys.id, input.id), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id });
      if (updated.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return { ok: true as const };
    }),
});

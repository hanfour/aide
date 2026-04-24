import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { organizations, auditLogs, requestBodies } from "@aide/db";
import { can } from "@aide/auth";
import { router } from "../procedures.js";
import { evaluatorProcedure } from "./_evaluatorGate.js";

const orgIdInput = z.object({ orgId: z.string().uuid() });

const settingsPatch = z.object({
  contentCaptureEnabled: z.boolean().optional(),
  retentionDaysOverride: z.number().int().min(1).max(365).nullable().optional(),
  llmEvalEnabled: z.boolean().optional(),
  llmEvalAccountId: z.string().uuid().nullable().optional(),
  llmEvalModel: z.string().nullable().optional(),
  captureThinking: z.boolean().optional(),
  rubricId: z.string().uuid().nullable().optional(),
  leaderboardEnabled: z.boolean().optional(),
});

export const contentCaptureRouter = router({
  getSettings: evaluatorProcedure
    .input(orgIdInput)
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, { type: "content_capture.read", orgId: input.orgId })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const [org] = await ctx.db
        .select({
          contentCaptureEnabled: organizations.contentCaptureEnabled,
          contentCaptureEnabledAt: organizations.contentCaptureEnabledAt,
          contentCaptureEnabledBy: organizations.contentCaptureEnabledBy,
          retentionDaysOverride: organizations.retentionDaysOverride,
          llmEvalEnabled: organizations.llmEvalEnabled,
          llmEvalAccountId: organizations.llmEvalAccountId,
          llmEvalModel: organizations.llmEvalModel,
          captureThinking: organizations.captureThinking,
          rubricId: organizations.rubricId,
          leaderboardEnabled: organizations.leaderboardEnabled,
        })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1);

      if (!org) throw new TRPCError({ code: "NOT_FOUND" });
      return org;
    }),

  setSettings: evaluatorProcedure
    .input(orgIdInput.extend({ patch: settingsPatch }))
    .mutation(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, { type: "content_capture.toggle", orgId: input.orgId })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      // Fetch current state to detect first-enable transition
      const [prev] = await ctx.db
        .select({
          contentCaptureEnabled: organizations.contentCaptureEnabled,
          contentCaptureEnabledAt: organizations.contentCaptureEnabledAt,
        })
        .from(organizations)
        .where(eq(organizations.id, input.orgId))
        .limit(1);

      if (!prev) throw new TRPCError({ code: "NOT_FOUND" });

      const turningOn =
        input.patch.contentCaptureEnabled === true &&
        prev.contentCaptureEnabled === false;

      const now = new Date();
      const updates: Record<string, unknown> = { ...input.patch };
      if (turningOn) {
        updates.contentCaptureEnabledAt = now;
        updates.contentCaptureEnabledBy = ctx.user.id;
      }

      await ctx.db
        .update(organizations)
        .set(updates)
        .where(eq(organizations.id, input.orgId));

      if (turningOn) {
        await ctx.db.insert(auditLogs).values({
          actorUserId: ctx.user.id,
          action: "content_capture.enabled",
          targetType: "organization",
          targetId: input.orgId,
          orgId: input.orgId,
          metadata: { patch: input.patch },
        });
      }

      return { success: true };
    }),

  wipeExistingCaptures: evaluatorProcedure
    .input(orgIdInput)
    .mutation(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, { type: "content_capture.toggle", orgId: input.orgId })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      await ctx.db
        .update(requestBodies)
        .set({ retentionUntil: sql`now()` })
        .where(eq(requestBodies.orgId, input.orgId));

      await ctx.db.insert(auditLogs).values({
        actorUserId: ctx.user.id,
        action: "content_capture.wiped",
        targetType: "organization",
        targetId: input.orgId,
        orgId: input.orgId,
        metadata: {},
      });

      return { success: true };
    }),
});

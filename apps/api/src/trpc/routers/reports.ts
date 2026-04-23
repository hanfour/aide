import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { evaluationReports } from "@aide/db";
import { can } from "@aide/auth";
import { router, protectedProcedure } from "../procedures.js";

// ─── Input primitives ─────────────────────────────────────────────────────────

const dateRange = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

// ─── LLM redaction ────────────────────────────────────────────────────────────

type EvaluationReportRow = typeof evaluationReports.$inferSelect;

function redactLlm(row: EvaluationReportRow, canSeeLlm: boolean): EvaluationReportRow {
  if (canSeeLlm) return row;
  return {
    ...row,
    llmNarrative: null,
    llmEvidence: null,
    llmModel: null,
    llmCalledAt: null,
    llmCostUsd: null,
    llmUpstreamAccountId: null,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const reportsRouter = router({
  /**
   * Returns the caller's most recent evaluation report (by periodStart desc).
   * The owner always sees their full LLM fields.
   * Requires `report.read_own`.
   */
  getOwnLatest: protectedProcedure
    .query(async ({ ctx }) => {
      if (!can(ctx.perm, { type: "report.read_own" })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const row = await ctx.db
        .select()
        .from(evaluationReports)
        .where(eq(evaluationReports.userId, ctx.user.id))
        .orderBy(desc(evaluationReports.periodStart))
        .limit(1)
        .then((r) => r[0] ?? null);

      return row;
    }),

  /**
   * Returns all of the caller's reports whose periodStart falls within [from, to].
   * Results are ordered by periodStart desc.
   * The owner always sees their full LLM fields.
   * Requires `report.read_own`.
   */
  getOwnRange: protectedProcedure
    .input(dateRange)
    .query(async ({ ctx, input }) => {
      if (!can(ctx.perm, { type: "report.read_own" })) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.userId, ctx.user.id),
            gte(evaluationReports.periodStart, new Date(input.from)),
            lte(evaluationReports.periodStart, new Date(input.to)),
          ),
        )
        .orderBy(desc(evaluationReports.periodStart));

      return rows;
    }),

  /**
   * Returns a specific user's reports within the given date range.
   * LLM fields are visible only to the report subject or an org_admin.
   * Requires `report.read_user` — granted when:
   *   - targetUserId === caller's own id (self-access), OR
   *   - caller is org_admin for the org.
   */
  getUser: protectedProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        userId: z.string().uuid(),
        range: dateRange,
      }),
    )
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "report.read_user",
          orgId: input.orgId,
          targetUserId: input.userId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.orgId, input.orgId),
            eq(evaluationReports.userId, input.userId),
            gte(evaluationReports.periodStart, new Date(input.range.from)),
            lte(evaluationReports.periodStart, new Date(input.range.to)),
          ),
        )
        .orderBy(desc(evaluationReports.periodStart));

      const canSeeLlm =
        input.userId === ctx.user.id ||
        can(ctx.perm, { type: "report.read_org", orgId: input.orgId });

      return rows.map((r) => redactLlm(r, canSeeLlm));
    }),

  /**
   * Returns aggregate-level team reports within the given date range.
   * LLM fields are visible only to org_admins; team_managers see them redacted.
   * Requires `report.read_team` — granted when caller is team_manager or org_admin.
   */
  getTeam: protectedProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        teamId: z.string().uuid(),
        range: dateRange,
      }),
    )
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, {
          type: "report.read_team",
          orgId: input.orgId,
          teamId: input.teamId,
        })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.orgId, input.orgId),
            eq(evaluationReports.teamId, input.teamId),
            gte(evaluationReports.periodStart, new Date(input.range.from)),
            lte(evaluationReports.periodStart, new Date(input.range.to)),
          ),
        )
        .orderBy(desc(evaluationReports.periodStart));

      // Only org_admins see LLM details — team_managers get them redacted.
      const canSeeLlm = can(ctx.perm, {
        type: "report.read_org",
        orgId: input.orgId,
      });

      return rows.map((r) => redactLlm(r, canSeeLlm));
    }),

  /**
   * Returns all org-wide reports within the given date range.
   * Caller must be org_admin (report.read_org), and therefore always sees
   * full LLM fields — no redaction applied at this scope.
   */
  getOrg: protectedProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        range: dateRange,
      }),
    )
    .query(async ({ ctx, input }) => {
      if (
        !can(ctx.perm, { type: "report.read_org", orgId: input.orgId })
      ) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const rows = await ctx.db
        .select()
        .from(evaluationReports)
        .where(
          and(
            eq(evaluationReports.orgId, input.orgId),
            gte(evaluationReports.periodStart, new Date(input.range.from)),
            lte(evaluationReports.periodStart, new Date(input.range.to)),
          ),
        )
        .orderBy(desc(evaluationReports.periodStart));

      // Caller is org_admin (enforced above) — full LLM fields returned.
      return rows;
    }),
});

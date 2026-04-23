import { TRPCError } from "@trpc/server";
import { protectedProcedure } from "../procedures.js";

/**
 * Base procedure for all evaluator feature endpoints.
 * Throws NOT_FOUND when ENABLE_EVALUATOR is false, hiding the feature
 * from API probes when it is not deployed.
 */
export const evaluatorProcedure = protectedProcedure.use(
  async ({ ctx, next }) => {
    if (!ctx.env.ENABLE_EVALUATOR) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    return next({ ctx });
  },
);

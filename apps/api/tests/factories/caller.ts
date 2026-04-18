import type { TRPCRouterCaller } from "@trpc/server";
import type { Database } from "@aide/db";
import { resolvePermissions } from "@aide/auth";
import { appRouter, type AppRouter } from "../../src/trpc/router.js";
import { createCallerFactory } from "../../src/trpc/procedures.js";

// Explicit annotations needed: tRPC v11's inferred caller types reference
// an internal `unstable-core-do-not-import.d-*.mts` bundle, which TS flags
// as non-portable (TS2742) when `declaration: true` is set in the base tsconfig.
// Anchoring to the publicly-exported `TRPCRouterCaller` avoids that.
type AppCaller = TRPCRouterCaller<
  AppRouter["_def"]["_config"]["$types"],
  AppRouter["_def"]["record"]
>;
type AppCallerInvocation = ReturnType<AppCaller>;

const createCaller: AppCaller = createCallerFactory(appRouter);

export async function callerFor(
  db: Database,
  userId: string,
  email = "x@x.test",
): Promise<AppCallerInvocation> {
  const perm = await resolvePermissions(db, userId);
  return createCaller({ db, user: { id: userId, email }, perm, reqId: "test" });
}

export async function anonCaller(db: Database): Promise<AppCallerInvocation> {
  return createCaller({ db, user: null, perm: null, reqId: "test" });
}

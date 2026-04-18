import { router } from "./procedures.js";
import { meRouter } from "./routers/me.js";
import { organizationsRouter } from "./routers/organizations.js";

export const appRouter = router({
  me: meRouter,
  organizations: organizationsRouter,
});

export type AppRouter = typeof appRouter;

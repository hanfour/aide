import { router } from "./procedures.js";
import { meRouter } from "./routers/me.js";
import { organizationsRouter } from "./routers/organizations.js";
import { departmentsRouter } from "./routers/departments.js";

export const appRouter = router({
  me: meRouter,
  organizations: organizationsRouter,
  departments: departmentsRouter,
});

export type AppRouter = typeof appRouter;

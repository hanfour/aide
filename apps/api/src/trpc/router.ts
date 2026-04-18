import { router } from "./procedures.js";
import { meRouter } from "./routers/me.js";
import { organizationsRouter } from "./routers/organizations.js";
import { departmentsRouter } from "./routers/departments.js";
import { teamsRouter } from "./routers/teams.js";
import { usersRouter } from "./routers/users.js";

export const appRouter = router({
  me: meRouter,
  organizations: organizationsRouter,
  departments: departmentsRouter,
  teams: teamsRouter,
  users: usersRouter,
});

export type AppRouter = typeof appRouter;

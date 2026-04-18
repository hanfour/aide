import { router } from './procedures.js'
import { meRouter } from './routers/me.js'
import { organizationsRouter } from './routers/organizations.js'
import { departmentsRouter } from './routers/departments.js'
import { teamsRouter } from './routers/teams.js'
import { usersRouter } from './routers/users.js'
import { invitesRouter } from './routers/invites.js'
import { rolesRouter } from './routers/roles.js'
import { auditLogsRouter } from './routers/audit-logs.js'

export const appRouter = router({
  me: meRouter,
  organizations: organizationsRouter,
  departments: departmentsRouter,
  teams: teamsRouter,
  users: usersRouter,
  invites: invitesRouter,
  roles: rolesRouter,
  auditLogs: auditLogsRouter
})

export type AppRouter = typeof appRouter

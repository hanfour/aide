import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './auth.js'
import { organizations, teams } from './org.js'

export const organizationMembers = pgTable(
  'organization_members',
  {
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({ pk: primaryKey({ columns: [t.orgId, t.userId] }) })
)

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({ pk: primaryKey({ columns: [t.teamId, t.userId] }) })
)

import { pgTable, text, timestamp, uuid, unique } from 'drizzle-orm/pg-core'
import { users } from './auth.js'
import { organizations } from './org.js'
import { roleEnum, scopeTypeEnum } from './roles.js'

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: roleEnum('role').notNull(),
    scopeType: scopeTypeEnum('scope_type').notNull(),
    scopeId: uuid('scope_id'),
    invitedBy: uuid('invited_by').notNull().references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    token: text('token').notNull().unique()
  },
  (t) => ({ uniqOrgEmail: unique('invites_org_email_unique').on(t.orgId, t.email) })
)

import { pgTable, text, timestamp, uuid, jsonb, bigserial, index } from 'drizzle-orm/pg-core'
import { users } from './auth.js'

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    orgId: uuid('org_id'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    orgCreated: index('idx_audit_logs_org_created').on(t.orgId, t.createdAt)
  })
)

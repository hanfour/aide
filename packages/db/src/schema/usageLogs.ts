import {
  pgTable,
  uuid,
  text,
  integer,
  bigserial,
  timestamp,
  decimal,
  boolean,
  inet,
  index,
} from 'drizzle-orm/pg-core'
import { users } from './auth.js'
import { organizations, teams } from './org.js'
import { apiKeys } from './apiKeys.js'
import { upstreamAccounts } from './accounts.js'

export const usageLogs = pgTable(
  'usage_logs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    requestId: text('request_id').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => upstreamAccounts.id, { onDelete: 'restrict' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    requestedModel: text('requested_model').notNull(),
    upstreamModel: text('upstream_model').notNull(),
    platform: text('platform').notNull(),
    surface: text('surface').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    inputCost: decimal('input_cost', { precision: 20, scale: 10 }).notNull().default('0'),
    outputCost: decimal('output_cost', { precision: 20, scale: 10 }).notNull().default('0'),
    cacheCreationCost: decimal('cache_creation_cost', { precision: 20, scale: 10 })
      .notNull()
      .default('0'),
    cacheReadCost: decimal('cache_read_cost', { precision: 20, scale: 10 })
      .notNull()
      .default('0'),
    totalCost: decimal('total_cost', { precision: 20, scale: 10 }).notNull().default('0'),
    rateMultiplier: decimal('rate_multiplier', { precision: 10, scale: 4 })
      .notNull()
      .default('1.0'),
    accountRateMultiplier: decimal('account_rate_multiplier', { precision: 10, scale: 4 })
      .notNull()
      .default('1.0'),
    stream: boolean('stream').notNull().default(false),
    statusCode: integer('status_code').notNull(),
    durationMs: integer('duration_ms').notNull(),
    firstTokenMs: integer('first_token_ms'),
    bufferReleasedAtMs: integer('buffer_released_at_ms'),
    upstreamRetries: integer('upstream_retries').notNull().default(0),
    failedAccountIds: uuid('failed_account_ids').array(),
    userAgent: text('user_agent'),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userTimeIdx: index('usage_logs_user_time_idx').on(t.userId, t.createdAt),
    apiKeyTimeIdx: index('usage_logs_api_key_time_idx').on(t.apiKeyId, t.createdAt),
    accountTimeIdx: index('usage_logs_account_time_idx').on(t.accountId, t.createdAt),
    orgTimeIdx: index('usage_logs_org_time_idx').on(t.orgId, t.createdAt),
    teamTimeIdx: index('usage_logs_team_time_idx').on(t.teamId, t.createdAt),
    modelIdx: index('usage_logs_model_idx').on(t.requestedModel),
  }),
)

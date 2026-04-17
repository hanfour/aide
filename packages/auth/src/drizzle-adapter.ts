import { DrizzleAdapter } from '@auth/drizzle-adapter'
import type { Database } from '@aide/db'
import { users, accounts, sessions, verificationTokens } from '@aide/db'

export function makeAdapter(db: Database) {
  return DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens
  })
}

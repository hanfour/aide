import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

describe('migration 0005 for gateway schema', () => {
  // Find the 0001_* migration file (drizzle-kit adds a random suffix).
  // Note: although the plan calls this "0005", the migration journal had only
  // 0000 when the four gateway-schema commits landed, so drizzle-kit assigned
  // the next available index: 0001.
  const drizzleDir = join(__dirname, '../../drizzle')
  const file = readdirSync(drizzleDir).find((f) => f.startsWith('0001_') && f.endsWith('.sql'))
  if (!file) throw new Error('Migration 0001_* not found — run pnpm -F @aide/db db:generate')
  const sql = readFileSync(join(drizzleDir, file), 'utf8')

  it('creates the 4 new tables', () => {
    expect(sql).toMatch(/CREATE TABLE.*"upstream_accounts"/)
    expect(sql).toMatch(/CREATE TABLE.*"credential_vault"/)
    expect(sql).toMatch(/CREATE TABLE.*"api_keys"/)
    expect(sql).toMatch(/CREATE TABLE.*"usage_logs"/)
  })
  it('creates hot-path indexes', () => {
    expect(sql).toMatch(/CREATE INDEX.*upstream_accounts_select_idx/)
    expect(sql).toMatch(/CREATE INDEX.*usage_logs_user_time_idx/)
  })
})

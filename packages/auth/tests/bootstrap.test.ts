import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import path from 'node:path'
import { createRequire } from 'node:module'
import { schema } from '@aide/db'
import type { Database } from '@aide/db'
import { decideSignUp, type BootstrapConfig } from '../src/bootstrap.js'

const require = createRequire(import.meta.url)
const migrationsFolder = path.resolve(
  path.dirname(require.resolve('@aide/db/package.json')),
  'drizzle'
)

let container: StartedPostgreSqlContainer
let pool: pg.Pool
let db: Database

const cfg: BootstrapConfig = {
  superAdminEmail: 'admin@example.com',
  defaultOrgSlug: 'demo',
  defaultOrgName: 'Demo'
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  pool = new pg.Pool({ connectionString: container.getConnectionUri() })
  db = drizzle(pool, { schema }) as unknown as Database
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await pool.end()
  await container.stop()
})

describe('decideSignUp', () => {
  it('allows first user when email matches BOOTSTRAP_SUPER_ADMIN_EMAIL', async () => {
    const decision = await decideSignUp(db, 'admin@example.com', cfg)
    expect(decision.allowed).toBe(true)
    if (decision.allowed) {
      expect(decision.action).toBe('bootstrap')
    }
  })

  it('denies first user when email does NOT match admin email', async () => {
    const decision = await decideSignUp(db, 'stranger@example.com', cfg)
    expect(decision.allowed).toBe(false)
  })
})

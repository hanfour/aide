import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import path from 'node:path'
import { createRequire } from 'node:module'
import Fastify from 'fastify'
import { cookiesPlugin } from '../../src/plugins/cookies.js'
import { authPlugin } from '../../src/plugins/auth.js'
import { sessions, users } from '@aide/db'

const require = createRequire(import.meta.url)
const migrationsFolder = path.resolve(
  path.dirname(require.resolve('@aide/db/package.json')),
  'drizzle'
)

let container: StartedPostgreSqlContainer
let pool: pg.Pool
let insertedUserId: string

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  pool = new pg.Pool({ connectionString: container.getConnectionUri() })
  const db = drizzle(pool, { schema: { users, sessions } })
  await migrate(db, { migrationsFolder })

  const [user] = await db
    .insert(users)
    .values({ email: 'u@test.com', name: 'U' })
    .returning()

  insertedUserId = user!.id

  await db.insert(sessions).values({
    sessionToken: 'test-token',
    userId: insertedUserId,
    expires: new Date(Date.now() + 60_000)
  })
})

afterAll(async () => {
  await pool.end()
  await container.stop()
})

function env(overrides: Record<string, unknown> = {}) {
  return {
    NODE_ENV: 'test' as const,
    DATABASE_URL: container.getConnectionUri(),
    AUTH_SECRET: 'a'.repeat(32),
    NEXTAUTH_URL: 'http://localhost:3000',
    GOOGLE_CLIENT_ID: 'x',
    GOOGLE_CLIENT_SECRET: 'x',
    GITHUB_CLIENT_ID: 'x',
    GITHUB_CLIENT_SECRET: 'x',
    BOOTSTRAP_SUPER_ADMIN_EMAIL: 'admin@example.com',
    BOOTSTRAP_DEFAULT_ORG_SLUG: 'demo',
    BOOTSTRAP_DEFAULT_ORG_NAME: 'Demo',
    LOG_LEVEL: 'error' as const,
    ENABLE_SWAGGER: false,
    ...overrides
  } as unknown as import('@aide/config').ServerEnv
}

describe('authPlugin', () => {
  it('decorates req.user when a valid session cookie is present', async () => {
    const app = Fastify()
    await app.register(cookiesPlugin)
    await app.register(authPlugin, { env: env() })
    app.get('/who', async (req) => ({ user: req.user }))

    const res = await app.inject({
      method: 'GET',
      url: '/who',
      cookies: { 'authjs.session-token': 'test-token' }
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ email: 'u@test.com' })
    await app.close()
  })

  it('leaves req.user null when no cookie present', async () => {
    const app = Fastify()
    await app.register(cookiesPlugin)
    await app.register(authPlugin, { env: env() })
    app.get('/who', async (req) => ({ user: req.user }))

    const res = await app.inject({ method: 'GET', url: '/who' })
    expect(res.json().user).toBeNull()
    await app.close()
  })
})

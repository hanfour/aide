import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema/index.js'

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 })
  const db = drizzle(pool, { schema })
  return { db, pool }
}

export type Database = ReturnType<typeof createDb>['db']
export { schema }
export * from './schema/index.js'

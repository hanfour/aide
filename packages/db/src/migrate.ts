import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')

  const pool = new pg.Pool({ connectionString: url, max: 1 })
  const db = drizzle(pool)

  const here = path.dirname(fileURLToPath(import.meta.url))
  const migrationsFolder = path.resolve(here, '..', 'drizzle')

  console.log(`Applying migrations from ${migrationsFolder}`)
  await migrate(db, { migrationsFolder })
  console.log('Migrations complete.')

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

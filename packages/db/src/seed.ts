import { createDb } from './index.js'
import { organizations, users } from './schema/index.js'
import { organizationMembers } from './schema/membership.js'
import { roleAssignments } from './schema/roles.js'
import { eq } from 'drizzle-orm'

async function main() {
  const url = process.env.DATABASE_URL
  const email = process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL
  const orgSlug = process.env.BOOTSTRAP_DEFAULT_ORG_SLUG ?? 'demo'
  const orgName = process.env.BOOTSTRAP_DEFAULT_ORG_NAME ?? 'Demo Org'

  if (!url) throw new Error('DATABASE_URL is required')
  if (!email) throw new Error('BOOTSTRAP_SUPER_ADMIN_EMAIL is required')

  const { db, pool } = createDb(url)

  const existingOrg = await db.query.organizations.findFirst({
    where: eq(organizations.slug, orgSlug)
  })
  const org =
    existingOrg ??
    (await db
      .insert(organizations)
      .values({ slug: orgSlug, name: orgName })
      .returning()
      .then((r) => r[0]!))

  const existingUser = await db.query.users.findFirst({ where: eq(users.email, email) })
  const user =
    existingUser ??
    (await db
      .insert(users)
      .values({ email, name: 'Bootstrap Super Admin' })
      .returning()
      .then((r) => r[0]!))

  await db
    .insert(organizationMembers)
    .values({ orgId: org.id, userId: user.id })
    .onConflictDoNothing()

  const existingRole = await db.query.roleAssignments.findFirst({
    where: (ra, { and, eq, isNull }) =>
      and(eq(ra.userId, user.id), eq(ra.role, 'super_admin'), isNull(ra.revokedAt))
  })

  if (!existingRole) {
    await db.insert(roleAssignments).values({
      userId: user.id,
      role: 'super_admin',
      scopeType: 'global'
    })
  }

  console.log(`Seeded org ${org.slug} (${org.id}) and super_admin ${user.email} (${user.id})`)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

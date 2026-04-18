import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, makeOrg, makeDept, makeUser, callerFor } from '../../factories/index.js'

let t: Awaited<ReturnType<typeof setupTestDb>>

beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t.stop()
})

describe('departments router', () => {
  it('org_admin can list depts in own org', async () => {
    const org = await makeOrg(t.db)
    await makeDept(t.db, org.id, { slug: 'd1' })
    await makeDept(t.db, org.id, { slug: 'd2' })
    const user = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: org.id
    })
    const caller = await callerFor(t.db, user.id)
    const result = await caller.departments.list({ orgId: org.id })
    expect(result.length).toBe(2)
  })

  it('org_admin can create dept in own org', async () => {
    const org = await makeOrg(t.db)
    const user = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: org.id
    })
    const caller = await callerFor(t.db, user.id)
    const created = await caller.departments.create({
      orgId: org.id,
      name: 'R&D',
      slug: 'rnd'
    })
    expect(created?.slug).toBe('rnd')
  })

  it('org_admin of one org cannot create in another', async () => {
    const orgA = await makeOrg(t.db)
    const orgB = await makeOrg(t.db)
    const user = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: orgA.id
    })
    const caller = await callerFor(t.db, user.id)
    await expect(
      caller.departments.create({ orgId: orgB.id, name: 'x', slug: 'xdept' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('dept_manager cannot create dept', async () => {
    const org = await makeOrg(t.db)
    const dept = await makeDept(t.db, org.id)
    const user = await makeUser(t.db, {
      role: 'dept_manager',
      scopeType: 'department',
      scopeId: dept.id
    })
    const caller = await callerFor(t.db, user.id)
    await expect(
      caller.departments.create({ orgId: org.id, name: 'y', slug: 'ydept' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('update: dept_manager cannot update (only org_admin)', async () => {
    const org = await makeOrg(t.db)
    const dept = await makeDept(t.db, org.id)
    const user = await makeUser(t.db, {
      role: 'dept_manager',
      scopeType: 'department',
      scopeId: dept.id
    })
    const caller = await callerFor(t.db, user.id)
    await expect(
      caller.departments.update({ id: dept.id, name: 'new' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

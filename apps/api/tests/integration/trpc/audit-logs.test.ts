import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, makeOrg, makeUser, callerFor } from '../../factories/index.js'

let t: Awaited<ReturnType<typeof setupTestDb>>

beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t.stop()
})

describe('auditLogs router', () => {
  it('creating an invite writes an audit entry readable by org_admin', async () => {
    const org = await makeOrg(t.db)
    const admin = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: org.id
    })
    const caller = await callerFor(t.db, admin.id)
    await caller.invites.create({
      orgId: org.id,
      email: 'ax@x.test',
      role: 'member',
      scopeType: 'organization',
      scopeId: org.id
    })
    const logs = await caller.auditLogs.list({ orgId: org.id })
    const found = logs.find((l) => l.action === 'invite.created')
    expect(found).toBeDefined()
    expect(found?.actorUserId).toBe(admin.id)
  })

  it('member cannot read audit', async () => {
    const org = await makeOrg(t.db)
    const user = await makeUser(t.db, {
      role: 'member',
      scopeType: 'organization',
      scopeId: org.id
    })
    const caller = await callerFor(t.db, user.id)
    await expect(caller.auditLogs.list({ orgId: org.id })).rejects.toMatchObject({
      code: 'FORBIDDEN'
    })
  })
})

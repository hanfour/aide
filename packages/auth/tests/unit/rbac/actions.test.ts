import { describe, it, expect } from 'vitest'
import type { Action } from '../../../src/rbac/actions'

describe('RBAC actions — gateway additions', () => {
  it('compiles with new account / api_key / usage action variants', () => {
    const samples: Action[] = [
      { type: 'account.read', orgId: 'x' },
      { type: 'account.create', orgId: 'x', teamId: null },
      { type: 'account.rotate', orgId: 'x', accountId: 'a' },
      { type: 'api_key.issue_own' },
      { type: 'api_key.issue_for_user', orgId: 'x', targetUserId: 'u' },
      { type: 'api_key.revoke', apiKeyId: 'k' },
      { type: 'usage.read_own' },
      { type: 'usage.read_team', orgId: 'x', teamId: 't' },
      { type: 'usage.read_org', orgId: 'x' },
    ]
    expect(samples.length).toBe(9)
  })
})

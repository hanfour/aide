import { describe, it, expect } from 'vitest'
import { accounts } from '../../src/schema/accounts'

describe('accounts schema', () => {
  it('exports table with required columns', () => {
    expect(accounts).toBeDefined()
    const cols = Object.keys(accounts)
    for (const c of [
      'id', 'orgId', 'teamId', 'name', 'platform', 'type',
      'schedulable', 'priority', 'concurrency', 'rateMultiplier',
      'rateLimitedAt', 'rateLimitResetAt', 'overloadUntil',
      'tempUnschedulableUntil', 'tempUnschedulableReason', 'lastUsedAt',
      'oauthRefreshFailCount', 'oauthRefreshLastError', 'oauthRefreshLastRunAt',
      'expiresAt', 'autoPauseOnExpired', 'status', 'errorMessage',
      'createdAt', 'updatedAt', 'deletedAt'
    ]) {
      expect(cols).toContain(c)
    }
  })
})

import { describe, it, expect } from 'vitest'
import { apiKeys } from '../../src/schema/apiKeys'

describe('apiKeys schema', () => {
  it('exports table with required columns including reveal tracking', () => {
    expect(apiKeys).toBeDefined()
    const cols = Object.keys(apiKeys)
    for (const c of [
      'id', 'userId', 'orgId', 'teamId', 'keyHash', 'keyPrefix', 'name',
      'status', 'ipWhitelist', 'ipBlacklist',
      'quotaUsd', 'quotaUsedUsd', 'rateLimit1dUsd',
      'issuedByUserId', 'revealTokenHash', 'revealTokenExpiresAt', 'revealedAt', 'revealedByIp',
      'lastUsedAt', 'expiresAt', 'createdAt', 'updatedAt', 'revokedAt'
    ]) {
      expect(cols).toContain(c)
    }
  })
})

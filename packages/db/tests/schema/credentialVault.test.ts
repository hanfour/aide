import { describe, it, expect } from 'vitest'
import { credentialVault } from '../../src/schema/credentialVault'

describe('credentialVault schema', () => {
  it('exports table with required columns', () => {
    expect(credentialVault).toBeDefined()
    const cols = Object.keys(credentialVault)
    for (const c of ['id', 'accountId', 'nonce', 'ciphertext', 'authTag', 'oauthExpiresAt', 'createdAt', 'rotatedAt']) {
      expect(cols).toContain(c)
    }
  })
})

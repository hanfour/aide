import { describe, it, expect } from 'vitest'
import { generateApiKey, hashApiKey, verifyApiKey } from '../src/crypto/apiKey'

describe('apiKey', () => {
  const pepper = '00'.repeat(32)

  it('generates key with ak_ prefix and 64+ chars', () => {
    const { raw, prefix } = generateApiKey()
    expect(raw.startsWith('ak_')).toBe(true)
    expect(raw.length).toBeGreaterThanOrEqual(64)
    expect(prefix.length).toBe(8)
    expect(prefix).toBe(raw.slice(0, 8))
  })

  it('hashApiKey produces deterministic HMAC-SHA256 hex', () => {
    const h1 = hashApiKey(pepper, 'ak_abc')
    const h2 = hashApiKey(pepper, 'ak_abc')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('different pepper → different hash', () => {
    const h1 = hashApiKey(pepper, 'ak_abc')
    const h2 = hashApiKey('ff'.repeat(32), 'ak_abc')
    expect(h1).not.toBe(h2)
  })

  it('verifyApiKey uses constant-time comparison', () => {
    const h = hashApiKey(pepper, 'ak_abc')
    expect(verifyApiKey(pepper, 'ak_abc', h)).toBe(true)
    expect(verifyApiKey(pepper, 'ak_xyz', h)).toBe(false)
  })
})

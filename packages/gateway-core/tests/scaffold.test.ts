import { describe, it, expect } from 'vitest'

describe('gateway-core scaffold', () => {
  it('imports from the package entrypoint', async () => {
    const mod = await import('../src/index.js')
    expect(mod).toBeDefined()
  })
})

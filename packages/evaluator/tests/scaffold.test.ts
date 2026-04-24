import { describe, it, expect } from 'vitest'

describe('evaluator scaffold', () => {
  it('package exports exist and module loads', async () => {
    const mod = await import('../src/index')
    expect(mod).toBeDefined()
  })
})

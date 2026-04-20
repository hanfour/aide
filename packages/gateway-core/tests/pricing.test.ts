import { describe, it, expect } from 'vitest'
import { loadPricing, resolveCost } from '../src/pricing'

describe('pricing', () => {
  const pricing = loadPricing()

  it('resolves cost for claude-3-5-sonnet-20241022', () => {
    const cost = resolveCost(pricing, 'claude-3-5-sonnet-20241022', {
      inputTokens: 1000, outputTokens: 500,
      cacheCreationTokens: 0, cacheReadTokens: 0,
    })
    // $3/M input + $15/M output → 0.003 + 0.0075 = 0.0105
    expect(cost.totalCost).toBeCloseTo(0.0105, 4)
  })

  it('returns zero cost + miss flag for unknown model', () => {
    const cost = resolveCost(pricing, 'unknown-model-xyz', {
      inputTokens: 1000, outputTokens: 500,
      cacheCreationTokens: 0, cacheReadTokens: 0,
    })
    expect(cost.totalCost).toBe(0)
    expect(cost.miss).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { usageLogs } from '../../src/schema/usageLogs'

describe('usageLogs schema', () => {
  it('exports append-only table with token + cost + observability columns', () => {
    expect(usageLogs).toBeDefined()
    const cols = Object.keys(usageLogs)
    for (const c of [
      'id', 'requestId',
      'userId', 'apiKeyId', 'accountId', 'orgId', 'teamId',
      'requestedModel', 'upstreamModel', 'platform', 'surface',
      'inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens',
      'inputCost', 'outputCost', 'cacheCreationCost', 'cacheReadCost', 'totalCost',
      'rateMultiplier', 'accountRateMultiplier',
      'stream', 'statusCode', 'durationMs', 'firstTokenMs', 'bufferReleasedAtMs',
      'upstreamRetries', 'failedAccountIds',
      'userAgent', 'ipAddress', 'createdAt'
    ]) {
      expect(cols).toContain(c)
    }
  })
})

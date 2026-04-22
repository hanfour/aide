import { describe, it, expect } from 'vitest'
import { gdprDeleteRequests } from '../../src/schema/gdprDeleteRequests'

describe('gdprDeleteRequests schema', () => {
  it('exports request/approval/execution tracking columns', () => {
    const cols = Object.keys(gdprDeleteRequests)
    for (const c of [
      'id', 'orgId', 'userId',
      'requestedAt', 'requestedByUserId', 'reason',
      'approvedAt', 'approvedByUserId',
      'rejectedAt', 'rejectedReason',
      'executedAt', 'scope',
    ]) {
      expect(cols).toContain(c)
    }
  })
})

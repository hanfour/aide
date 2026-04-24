import { describe, it, expect } from 'vitest'
import { requestBodies } from '../../src/schema/requestBodies'

describe('requestBodies schema', () => {
  it('exports encrypted body columns + cleartext metadata + retention', () => {
    const cols = Object.keys(requestBodies)
    for (const c of [
      'requestId', 'orgId',
      'requestBodySealed', 'responseBodySealed', 'thinkingBodySealed', 'attemptErrorsSealed',
      'requestParams', 'stopReason', 'clientUserAgent', 'clientSessionId',
      'attachmentsMeta', 'cacheControlMarkers',
      'toolResultTruncated', 'bodyTruncated',
      'capturedAt', 'retentionUntil',
    ]) {
      expect(cols).toContain(c)
    }
  })
})

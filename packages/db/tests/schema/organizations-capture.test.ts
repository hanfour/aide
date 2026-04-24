import { describe, it, expect } from 'vitest'
import { organizations } from '../../src/schema/org'

describe('organizations — content capture columns', () => {
  it('exposes capture toggle, retention override, LLM eval binding, capture_thinking, rubric link, leaderboard', () => {
    const cols = Object.keys(organizations)
    for (const c of [
      'contentCaptureEnabled', 'contentCaptureEnabledAt', 'contentCaptureEnabledBy',
      'retentionDaysOverride', 'llmEvalEnabled', 'llmEvalAccountId', 'llmEvalModel',
      'captureThinking', 'rubricId', 'leaderboardEnabled',
    ]) {
      expect(cols).toContain(c)
    }
  })
})

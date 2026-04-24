import { describe, it, expect } from 'vitest'
import { evaluationReports } from '../../src/schema/evaluationReports'

describe('evaluationReports schema', () => {
  it('exports rule-based fields + optional LLM fields + trigger audit', () => {
    const cols = Object.keys(evaluationReports)
    for (const c of [
      'id', 'orgId', 'userId', 'teamId',
      'periodStart', 'periodEnd', 'periodType',
      'rubricId', 'rubricVersion',
      'totalScore', 'sectionScores', 'signalsSummary', 'dataQuality',
      'llmNarrative', 'llmEvidence', 'llmModel', 'llmCalledAt', 'llmCostUsd', 'llmUpstreamAccountId',
      'triggeredBy', 'triggeredByUser',
      'createdAt', 'updatedAt',
    ]) {
      expect(cols).toContain(c)
    }
  })
})

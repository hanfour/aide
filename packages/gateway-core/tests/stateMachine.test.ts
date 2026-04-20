import { describe, it, expect } from 'vitest'
import { classifyUpstreamError } from '../src/stateMachine/classifier'

describe('classifyUpstreamError', () => {
  it('429 → failover with rate_limited_at set', () => {
    const act = classifyUpstreamError({ status: 429, retryAfter: 60 })
    expect(act.kind).toBe('switch_account')
    expect(act.stateUpdate?.rateLimitedAt).toBeDefined()
    expect(act.stateUpdate?.rateLimitResetAt).toBeDefined()
  })

  it('529 → failover with overload_until', () => {
    const act = classifyUpstreamError({ status: 529 })
    expect(act.kind).toBe('switch_account')
    expect(act.stateUpdate?.overloadUntil).toBeDefined()
  })

  it('401 → failover + status=error', () => {
    const act = classifyUpstreamError({ status: 401 })
    expect(act.kind).toBe('switch_account')
    expect(act.stateUpdate?.status).toBe('error')
  })

  it('400 → fatal (no failover)', () => {
    const act = classifyUpstreamError({ status: 400 })
    expect(act.kind).toBe('fatal')
  })

  it('5xx → switch_account with temp_unschedulable_until', () => {
    const act = classifyUpstreamError({ status: 502 })
    expect(act.kind).toBe('switch_account')
    expect(act.stateUpdate?.tempUnschedulableUntil).toBeDefined()
  })

  it('connection error → retry_same_account', () => {
    const act = classifyUpstreamError({ kind: 'connection' })
    expect(act.kind).toBe('retry_same_account')
  })
})

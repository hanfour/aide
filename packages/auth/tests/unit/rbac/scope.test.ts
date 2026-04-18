import { describe, it, expect } from 'vitest'
import { expandScope } from '../../../src/rbac/scope'

const orgs = [{ id: 'org-1' }, { id: 'org-2' }]
const depts = [
  { id: 'dept-1a', orgId: 'org-1' },
  { id: 'dept-1b', orgId: 'org-1' },
  { id: 'dept-2a', orgId: 'org-2' }
]
const teams = [
  { id: 'team-1a', orgId: 'org-1', departmentId: 'dept-1a' },
  { id: 'team-1b', orgId: 'org-1', departmentId: 'dept-1b' },
  { id: 'team-1c', orgId: 'org-1', departmentId: null },
  { id: 'team-2a', orgId: 'org-2', departmentId: 'dept-2a' }
]
const corpus = { orgs, depts, teams }

describe('expandScope', () => {
  it('global scope covers all orgs/depts/teams', () => {
    const exp = expandScope(
      { role: 'super_admin', scopeType: 'global', scopeId: null },
      corpus
    )
    expect([...exp.orgs]).toEqual(['org-1', 'org-2'])
    expect([...exp.depts]).toEqual(['dept-1a', 'dept-1b', 'dept-2a'])
    expect([...exp.teams]).toEqual(['team-1a', 'team-1b', 'team-1c', 'team-2a'])
  })

  it('organization scope covers org + its depts + its teams', () => {
    const exp = expandScope(
      { role: 'org_admin', scopeType: 'organization', scopeId: 'org-1' },
      corpus
    )
    expect([...exp.orgs]).toEqual(['org-1'])
    expect([...exp.depts]).toEqual(['dept-1a', 'dept-1b'])
    expect([...exp.teams]).toEqual(['team-1a', 'team-1b', 'team-1c'])
  })

  it('department scope covers dept + its teams only', () => {
    const exp = expandScope(
      { role: 'dept_manager', scopeType: 'department', scopeId: 'dept-1a' },
      corpus
    )
    expect([...exp.orgs]).toEqual([])
    expect([...exp.depts]).toEqual(['dept-1a'])
    expect([...exp.teams]).toEqual(['team-1a'])
  })

  it('team scope covers exactly that team', () => {
    const exp = expandScope(
      { role: 'team_manager', scopeType: 'team', scopeId: 'team-1a' },
      corpus
    )
    expect([...exp.orgs]).toEqual([])
    expect([...exp.depts]).toEqual([])
    expect([...exp.teams]).toEqual(['team-1a'])
  })

  it('unknown scope id returns empty sets without throwing', () => {
    const exp = expandScope(
      { role: 'org_admin', scopeType: 'organization', scopeId: 'org-missing' },
      corpus
    )
    expect(exp.teams.size).toBe(0)
  })
})

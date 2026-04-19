import type { Role, ScopeType } from './actions.js'

export interface Assignment {
  role: Role
  scopeType: ScopeType
  scopeId: string | null
}

export interface Corpus {
  orgs: ReadonlyArray<{ id: string }>
  depts: ReadonlyArray<{ id: string; orgId: string }>
  teams: ReadonlyArray<{
    id: string
    orgId: string
    departmentId: string | null
  }>
}

export interface ExpandedScope {
  orgs: Set<string>
  depts: Set<string>
  teams: Set<string>
}

export function expandScope(a: Assignment, c: Corpus): ExpandedScope {
  const orgs = new Set<string>()
  const depts = new Set<string>()
  const teams = new Set<string>()

  switch (a.scopeType) {
    case 'global':
      for (const o of c.orgs) orgs.add(o.id)
      for (const d of c.depts) depts.add(d.id)
      for (const t of c.teams) teams.add(t.id)
      return { orgs, depts, teams }
    case 'organization': {
      if (!a.scopeId) return { orgs, depts, teams }
      orgs.add(a.scopeId)
      for (const d of c.depts) if (d.orgId === a.scopeId) depts.add(d.id)
      for (const t of c.teams) if (t.orgId === a.scopeId) teams.add(t.id)
      return { orgs, depts, teams }
    }
    case 'department': {
      if (!a.scopeId) return { orgs, depts, teams }
      depts.add(a.scopeId)
      for (const t of c.teams) if (t.departmentId === a.scopeId) teams.add(t.id)
      return { orgs, depts, teams }
    }
    case 'team':
      if (a.scopeId) teams.add(a.scopeId)
      return { orgs, depts, teams }
  }
}

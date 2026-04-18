import type { Role, ScopeType } from './actions.js'

export interface ActiveAssignment {
  id: string
  role: Role
  scopeType: ScopeType
  scopeId: string | null
}

export interface UserPermissions {
  userId: string
  assignments: ActiveAssignment[]
  rolesAtGlobal: Set<Role>
  rolesByOrg: Map<string, Set<Role>>
  rolesByDept: Map<string, Set<Role>>
  rolesByTeam: Map<string, Set<Role>>
  coveredOrgs: Set<string>
  coveredDepts: Set<string>
  coveredTeams: Set<string>
}

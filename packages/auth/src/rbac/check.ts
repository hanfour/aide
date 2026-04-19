import type { Action, Role, ScopeType } from "./actions.js";
import { ROLE_RANK } from "./actions.js";
import type { UserPermissions } from "./permissions.js";

function hasGlobal(perm: UserPermissions, role: Role): boolean {
  return perm.rolesAtGlobal.has(role);
}

function rolesAt(
  perm: UserPermissions,
  scopeType: Exclude<ScopeType, "global">,
  scopeId: string,
): Set<Role> {
  const map =
    scopeType === "organization"
      ? perm.rolesByOrg
      : scopeType === "department"
        ? perm.rolesByDept
        : perm.rolesByTeam;
  return map.get(scopeId) ?? new Set();
}

function coversOrg(perm: UserPermissions, orgId: string): boolean {
  return perm.coveredOrgs.has(orgId);
}
function coversDept(perm: UserPermissions, deptId: string): boolean {
  return perm.coveredDepts.has(deptId);
}
function coversTeam(perm: UserPermissions, teamId: string): boolean {
  return perm.coveredTeams.has(teamId);
}

function hasAnyOrgAdmin(perm: UserPermissions): boolean {
  for (const [, rolesSet] of perm.rolesByOrg) {
    if (rolesSet.has("org_admin")) return true;
  }
  return false;
}

function hasAnyDeptManager(perm: UserPermissions): boolean {
  for (const [, rolesSet] of perm.rolesByDept) {
    if (rolesSet.has("dept_manager")) return true;
  }
  return false;
}

function maxRoleForOrg(perm: UserPermissions, orgId: string): number {
  let max = 0;
  if (hasGlobal(perm, "super_admin"))
    max = Math.max(max, ROLE_RANK.super_admin);
  for (const r of rolesAt(perm, "organization", orgId))
    max = Math.max(max, ROLE_RANK[r]);
  return max;
}

function maxRoleForTeam(perm: UserPermissions, teamId: string): number {
  let max = 0;
  if (hasGlobal(perm, "super_admin"))
    max = Math.max(max, ROLE_RANK.super_admin);
  for (const r of rolesAt(perm, "team", teamId))
    max = Math.max(max, ROLE_RANK[r]);
  if (coversTeam(perm, teamId)) {
    if (hasAnyOrgAdmin(perm)) max = Math.max(max, ROLE_RANK.org_admin);
    if (hasAnyDeptManager(perm)) max = Math.max(max, ROLE_RANK.dept_manager);
  }
  return max;
}

export function can(perm: UserPermissions, action: Action): boolean {
  if (hasGlobal(perm, "super_admin")) return true;

  switch (action.type) {
    case "org.read":
      return coversOrg(perm, action.orgId);
    case "org.update":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "org.create":
    case "org.delete":
      return false;
    case "dept.read":
      return coversDept(perm, action.deptId);
    case "dept.create":
    case "dept.update":
    case "dept.delete":
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "team.read":
      return coversTeam(perm, action.teamId);
    case "team.create":
      if (rolesAt(perm, "organization", action.orgId).has("org_admin"))
        return true;
      if (action.deptId) {
        return (
          rolesAt(perm, "department", action.deptId).has("dept_manager") &&
          coversOrg(perm, action.orgId) &&
          coversDept(perm, action.deptId)
        );
      }
      return false;
    case "team.update":
    case "team.delete":
    case "team.add_member":
      return (
        coversTeam(perm, action.teamId) &&
        maxRoleForTeam(perm, action.teamId) >= ROLE_RANK.team_manager
      );
    case "user.read":
      if (action.targetUserId === perm.userId) return true;
      return false;
    case "user.invite":
      if (action.teamId) {
        return (
          coversTeam(perm, action.teamId) &&
          maxRoleForTeam(perm, action.teamId) >= ROLE_RANK.team_manager
        );
      }
      if (action.deptId) {
        return rolesAt(perm, "department", action.deptId).has("dept_manager");
      }
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
    case "role.grant": {
      const grantRank = ROLE_RANK[action.role];
      if (action.scopeType === "global") return false;
      const scopeId = action.scopeId ?? "";
      let actorRank = 0;
      if (action.scopeType === "organization") {
        actorRank = maxRoleForOrg(perm, scopeId);
      } else if (action.scopeType === "department") {
        const directDept = rolesAt(perm, "department", scopeId).has(
          "dept_manager",
        )
          ? ROLE_RANK.dept_manager
          : 0;
        const inheritedOrg =
          coversDept(perm, scopeId) && hasAnyOrgAdmin(perm)
            ? ROLE_RANK.org_admin
            : 0;
        actorRank = Math.max(directDept, inheritedOrg);
      } else if (action.scopeType === "team") {
        actorRank = maxRoleForTeam(perm, scopeId);
        if (coversTeam(perm, scopeId)) {
          for (const [, rolesSet] of perm.rolesByOrg) {
            if (rolesSet.has("org_admin")) {
              actorRank = Math.max(actorRank, ROLE_RANK.org_admin);
            }
          }
          for (const [, rolesSet] of perm.rolesByDept) {
            if (rolesSet.has("dept_manager")) {
              actorRank = Math.max(actorRank, ROLE_RANK.dept_manager);
            }
          }
        }
      }
      return actorRank > 0 && grantRank < actorRank;
    }
    case "role.revoke":
      return (
        perm.rolesAtGlobal.size > 0 ||
        perm.rolesByOrg.size > 0 ||
        perm.rolesByDept.size > 0
      );
    case "audit.read":
      if (action.deptId) {
        return (
          rolesAt(perm, "department", action.deptId).has("dept_manager") ||
          rolesAt(perm, "organization", action.orgId).has("org_admin")
        );
      }
      return rolesAt(perm, "organization", action.orgId).has("org_admin");
  }
}

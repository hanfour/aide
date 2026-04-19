import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestDb,
  makeOrg,
  makeDept,
  makeTeam,
  makeUser,
  callerFor,
} from "../../factories/index.js";

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});

describe("users router", () => {
  it("member can get self", async () => {
    const user = await makeUser(t.db);
    const caller = await callerFor(t.db, user.id);
    const res = await caller.users.get({ id: user.id });
    expect(res.id).toBe(user.id);
  });

  it("member cannot get another user not on shared team", async () => {
    const other = await makeUser(t.db);
    const user = await makeUser(t.db);
    const caller = await callerFor(t.db, user.id);
    await expect(caller.users.get({ id: other.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("team_manager can get teammate", async () => {
    const org = await makeOrg(t.db);
    const team = await makeTeam(t.db, org.id);
    const mgr = await makeUser(t.db, {
      role: "team_manager",
      scopeType: "team",
      scopeId: team.id,
    });
    const teammate = await makeUser(t.db, { teamId: team.id });
    const caller = await callerFor(t.db, mgr.id);
    const res = await caller.users.get({ id: teammate.id });
    expect(res.id).toBe(teammate.id);
  });

  it("list by teamId returns team members (perm-gated)", async () => {
    const org = await makeOrg(t.db);
    const team = await makeTeam(t.db, org.id);
    const mgr = await makeUser(t.db, {
      role: "team_manager",
      scopeType: "team",
      scopeId: team.id,
      teamId: team.id,
    });
    await makeUser(t.db, { teamId: team.id });
    await makeUser(t.db, { teamId: team.id });
    const caller = await callerFor(t.db, mgr.id);
    const res = await caller.users.list({ teamId: team.id });
    expect(res.length).toBeGreaterThanOrEqual(3);
  });

  it("org_admin can get a member in own org even if not on shared team", async () => {
    const org = await makeOrg(t.db);
    const admin = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
    });
    const member = await makeUser(t.db, { orgId: org.id });
    const caller = await callerFor(t.db, admin.id);
    const res = await caller.users.get({ id: member.id });
    expect(res.id).toBe(member.id);
  });

  it("users.list by orgId forbidden for member-role", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "member",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, user.id);
    await expect(caller.users.list({ orgId: org.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("dept_manager cannot get org-peer who is not on a team in the dept", async () => {
    const org = await makeOrg(t.db);
    const dept = await makeDept(t.db, org.id);
    const otherTeam = await makeTeam(t.db, org.id); // NOT inside dept
    const mgr = await makeUser(t.db, {
      role: "dept_manager",
      scopeType: "department",
      scopeId: dept.id,
    });
    const peer = await makeUser(t.db, { orgId: org.id, teamId: otherTeam.id });
    const caller = await callerFor(t.db, mgr.id);
    await expect(caller.users.get({ id: peer.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("team_manager cannot get member of same org not on their team", async () => {
    const org = await makeOrg(t.db);
    const teamA = await makeTeam(t.db, org.id);
    const teamB = await makeTeam(t.db, org.id);
    const mgr = await makeUser(t.db, {
      role: "team_manager",
      scopeType: "team",
      scopeId: teamA.id,
    });
    const peer = await makeUser(t.db, { orgId: org.id, teamId: teamB.id });
    const caller = await callerFor(t.db, mgr.id);
    await expect(caller.users.get({ id: peer.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

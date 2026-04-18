import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestDb,
  makeOrg,
  makeUser,
  callerFor,
  anonCaller,
} from "../../factories/index.js";

let t: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  t = await setupTestDb();
});
afterAll(async () => {
  await t.stop();
});

describe("me router", () => {
  it("requires authentication for session", async () => {
    const caller = await anonCaller(t.db);
    await expect(caller.me.session()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("returns session for authenticated user", async () => {
    const org = await makeOrg(t.db);
    const user = await makeUser(t.db, {
      role: "org_admin",
      scopeType: "organization",
      scopeId: org.id,
      orgId: org.id,
    });
    const caller = await callerFor(t.db, user.id, user.email);
    const s = await caller.me.session();
    expect(s.user.id).toBe(user.id);
    expect(s.coveredOrgs).toContain(org.id);
  });

  it("updateProfile sets name", async () => {
    const user = await makeUser(t.db);
    const caller = await callerFor(t.db, user.id, user.email);
    const updated = await caller.me.updateProfile({ name: "New Name" });
    expect(updated?.name).toBe("New Name");
  });
});

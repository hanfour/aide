/**
 * Thin client for the gated /test-seed endpoint exposed by the API when
 * NODE_ENV=test + ENABLE_TEST_SEED=true + TEST_SEED_TOKEN set.
 *
 * Every spec must reset DB state at the top of its run to stay independent
 * of prior specs (we run serially on a single DB — see playwright.config.ts).
 */

export interface SeedUser {
  id?: string;
  email: string;
  name?: string;
  sessionToken?: string;
  sessionTtlSeconds?: number;
}

export interface SeedOrg {
  id?: string;
  slug: string;
  name: string;
}

export interface SeedRoleAssignment {
  userId: string;
  role: "super_admin" | "org_admin" | "dept_manager" | "team_manager" | "member";
  scopeType: "global" | "organization" | "department" | "team";
  scopeId?: string;
}

export interface SeedOrgMember {
  orgId: string;
  userId: string;
}

export interface SeedPayload {
  reset?: boolean;
  orgs?: SeedOrg[];
  users?: SeedUser[];
  orgMembers?: SeedOrgMember[];
  roleAssignments?: SeedRoleAssignment[];
}

export interface SeedResult {
  ok: true;
  resetAt: string | null;
  orgs: Array<{ id: string; slug: string; name: string }>;
  users: Array<{ id: string; email: string; sessionToken?: string }>;
}

const API_PORT = Number(process.env.E2E_API_PORT ?? 3001);
const SEED_TOKEN =
  process.env.TEST_SEED_TOKEN ?? "e2e-test-token-0000000000000000000000";
const SEED_URL = `http://localhost:${API_PORT}/test-seed`;

export async function seedDb(body: SeedPayload = {}): Promise<SeedResult> {
  const res = await fetch(SEED_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-seed-token": SEED_TOKEN,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`seedDb failed: ${res.status} ${text}`);
  }
  return (await res.json()) as SeedResult;
}

export async function resetDb(): Promise<SeedResult> {
  return seedDb({ reset: true });
}

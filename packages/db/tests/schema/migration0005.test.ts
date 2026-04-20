import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

describe("gateway schema migration", () => {
  // drizzle-kit generates 0001_* on top of the existing 0000_* baseline.
  // (Plan document originally said "0005" — that number assumed Plans 1-3 had
  // generated 0001-0004; in reality Plan 1 emitted only 0000, so this is 0001.)
  const drizzleDir = join(__dirname, "../../drizzle");
  const file = readdirSync(drizzleDir).find(
    (f) => f.startsWith("0001_") && f.endsWith(".sql"),
  );
  if (!file)
    throw new Error(
      "Migration 0001_* not found — run pnpm -F @aide/db db:generate",
    );
  const sql = readFileSync(join(drizzleDir, file), "utf8");

  it("creates the 4 new tables", () => {
    expect(sql).toMatch(/CREATE TABLE.*"upstream_accounts"/);
    expect(sql).toMatch(/CREATE TABLE.*"credential_vault"/);
    expect(sql).toMatch(/CREATE TABLE.*"api_keys"/);
    expect(sql).toMatch(/CREATE TABLE.*"usage_logs"/);
  });
  it("creates hot-path indexes", () => {
    expect(sql).toMatch(/CREATE INDEX.*upstream_accounts_select_idx/);
    expect(sql).toMatch(/CREATE INDEX.*usage_logs_user_time_idx/);
  });
});

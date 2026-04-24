import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("migration 0003 — platform rubric seed", () => {
  const drizzleDir = join(__dirname, "../../drizzle");
  const sql = readFileSync(
    join(drizzleDir, "0003_seed_platform_rubrics.sql"),
    "utf8",
  );

  it("inserts 3 platform rubrics", () => {
    const insertCount = (sql.match(/INSERT INTO\s+rubrics/gi) ?? []).length;
    expect(insertCount).toBe(3);
  });

  it("all inserts use org_id = NULL", () => {
    const nullOrgCount = (sql.match(/\bNULL,\s*\n\s*'[^']+'/g) ?? []).length;
    expect(nullOrgCount).toBe(3);
  });

  it("all inserts use is_default = true", () => {
    const trueCount = (sql.match(/\btrue\b/gi) ?? []).length;
    expect(trueCount).toBeGreaterThanOrEqual(3);
  });

  it("version is 1.0.0 for all 3 rows", () => {
    const versionMatches = sql.match(/'1\.0\.0'/g) ?? [];
    expect(versionMatches.length).toBe(3);
  });

  it("includes locale indicator for each locale in the embedded JSON", () => {
    expect(sql).toMatch(/"locale":\s*"en"/);
    expect(sql).toMatch(/"locale":\s*"zh-Hant"/);
    expect(sql).toMatch(/"locale":\s*"ja"/);
  });

  it("uses dollar-quoting for JSON embedding", () => {
    const dollarQuoteCount = (sql.match(/\$json\$/g) ?? []).length;
    // Each INSERT has an opening and closing $json$ delimiter → 2 per row × 3 rows = 6
    expect(dollarQuoteCount).toBe(6);
  });

  it("uses gen_random_uuid() for id generation", () => {
    const uuidCount = (sql.match(/gen_random_uuid\(\)/gi) ?? []).length;
    expect(uuidCount).toBe(3);
  });

  it("includes statement-breakpoint markers", () => {
    const breakpointCount = (sql.match(/-->\s*statement-breakpoint/g) ?? [])
      .length;
    expect(breakpointCount).toBeGreaterThanOrEqual(3);
  });
});

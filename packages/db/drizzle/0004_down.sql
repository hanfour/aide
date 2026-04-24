-- packages/db/drizzle/0004_down.sql
-- EMERGENCY ROLLBACK ONLY. Not auto-applied by drizzle migrator.
-- Run manually with: psql $DATABASE_URL -f packages/db/drizzle/0004_down.sql
-- After running, manually remove the 0004 entry from drizzle/meta/_journal.json
-- and delete drizzle/meta/0004_snapshot.json.

BEGIN;

DROP INDEX IF EXISTS "llm_usage_org_month_idx";
DROP TABLE IF EXISTS "llm_usage_events";

ALTER TABLE "organizations"
  DROP COLUMN IF EXISTS "llm_halted_until_month_end",
  DROP COLUMN IF EXISTS "llm_budget_overage_behavior",
  DROP COLUMN IF EXISTS "llm_monthly_budget_usd",
  DROP COLUMN IF EXISTS "llm_facet_model",
  DROP COLUMN IF EXISTS "llm_facet_enabled";

COMMIT;

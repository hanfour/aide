-- packages/db/drizzle/0006_down.sql
-- EMERGENCY ROLLBACK ONLY. Not auto-applied by drizzle migrator.
-- Run manually with: psql $DATABASE_URL -f packages/db/drizzle/0006_down.sql
-- After running, manually remove the 0006 entry from drizzle/meta/_journal.json.

BEGIN;

ALTER TABLE "organizations" DROP COLUMN IF EXISTS "llm_halted_at";

COMMIT;

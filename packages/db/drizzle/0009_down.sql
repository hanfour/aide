-- packages/db/drizzle/0009_down.sql
-- EMERGENCY ROLLBACK ONLY. Not auto-applied by drizzle migrator.
-- Run manually with: psql $DATABASE_URL -f packages/db/drizzle/0009_down.sql
-- After running, manually remove the 0009 entry from drizzle/meta/_journal.json.
--
-- Reverses 0009_cold_speed_demon.sql by dropping model_pricing. The seed
-- rows, indexes, and CHECK constraints are dropped implicitly with the table.

BEGIN;

DROP TABLE IF EXISTS model_pricing;

COMMIT;

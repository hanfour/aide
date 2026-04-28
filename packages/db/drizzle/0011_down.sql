-- packages/db/drizzle/0011_down.sql
-- EMERGENCY ROLLBACK ONLY. Not auto-applied by drizzle migrator.
-- Run manually with: psql $DATABASE_URL -f packages/db/drizzle/0011_down.sql
-- After running, manually remove the 0011 entry from drizzle/meta/_journal.json.
--
-- Reverses 0011_empty_dust.sql by dropping the cache_read column.
-- Existing rows lose their backfilled values; new pricing-lookup queries
-- through computeCost will fall back to billing cache_read at the
-- input rate (the pre-PR-#32-follow-up behaviour).

BEGIN;

ALTER TABLE model_pricing DROP COLUMN IF EXISTS cache_read_per_million_micros;

COMMIT;

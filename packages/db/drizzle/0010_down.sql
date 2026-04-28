-- packages/db/drizzle/0010_down.sql
-- EMERGENCY ROLLBACK ONLY. Not auto-applied by drizzle migrator.
-- Run manually with: psql $DATABASE_URL -f packages/db/drizzle/0010_down.sql
-- After running, manually remove the 0010 entry from drizzle/meta/_journal.json.
--
-- Reverses 0010_same_the_liberteens.sql by dropping the partial idx, the
-- group_id FK, and the six new columns.  Pre-existing 4A/4C rows in
-- usage_logs are preserved — only the new columns are dropped, so historical
-- request data stays intact.

BEGIN;

DROP INDEX IF EXISTS usage_logs_group_time_idx;

-- DROP COLUMN cascades to the FK constraint; explicit DROP is defensive.
ALTER TABLE usage_logs
  DROP CONSTRAINT IF EXISTS usage_logs_group_id_account_groups_id_fk;

ALTER TABLE usage_logs
  DROP COLUMN IF EXISTS group_id,
  DROP COLUMN IF EXISTS actual_cost_usd,
  DROP COLUMN IF EXISTS cached_input_cost,
  DROP COLUMN IF EXISTS cached_input_tokens,
  DROP COLUMN IF EXISTS cache_creation_1h_tokens,
  DROP COLUMN IF EXISTS cache_creation_5m_tokens;

COMMIT;

-- packages/db/drizzle/0008_down.sql
-- EMERGENCY ROLLBACK ONLY. Not auto-applied by drizzle migrator.
-- Run manually with: psql $DATABASE_URL -f packages/db/drizzle/0008_down.sql
-- After running, manually remove the 0008 entry from drizzle/meta/_journal.json.
--
-- Reverses 0008_clear_mother_askani.sql by:
--   * Dropping subscription_tier column + CHECK constraint on upstream_accounts.
--   * Dropping api_keys.group_id column (cascades the partial index and FK).
--   * Dropping account_group_members + account_groups (cascade on FKs).
--
-- Backfill data (legacy-anthropic groups, member rows, api_keys.group_id
-- assignments) is implicitly reversed by the table drops and column drop.

BEGIN;

ALTER TABLE upstream_accounts
  DROP CONSTRAINT IF EXISTS subscription_tier_values;

ALTER TABLE upstream_accounts
  DROP COLUMN IF EXISTS subscription_tier;

DROP INDEX IF EXISTS api_keys_group_idx;
ALTER TABLE api_keys DROP COLUMN IF EXISTS group_id;

DROP TABLE IF EXISTS account_group_members;
DROP TABLE IF EXISTS account_groups;

COMMIT;

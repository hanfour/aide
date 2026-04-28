-- packages/db/drizzle/0008_down.sql
-- EMERGENCY ROLLBACK ONLY. Not auto-applied by drizzle migrator.
-- Run manually with: psql $DATABASE_URL -f packages/db/drizzle/0008_down.sql
-- After running, manually remove the 0008 entry from drizzle/meta/_journal.json.
--
-- Reverses 0008_magical_daimon_hellstrom.sql by:
--   * Dropping subscription_tier CHECK + column on upstream_accounts.
--   * Dropping api_keys.group_id (cascades the partial index + FK constraint).
--   * Dropping account_group_members + account_groups (cascades the
--     CHECKs, UNIQUE, indexes, and FK constraints owned by those tables).
--
-- Backfill data (legacy-anthropic groups, member rows, api_keys.group_id
-- assignments) is implicitly reversed by the table drops and column drop.

BEGIN;

ALTER TABLE upstream_accounts
  DROP CONSTRAINT IF EXISTS subscription_tier_values;

ALTER TABLE upstream_accounts
  DROP COLUMN IF EXISTS subscription_tier;

-- DROP COLUMN cascades to api_keys_group_idx and the FK constraint; the
-- explicit DROP INDEX is defensive (no-op if cascade already removed it).
DROP INDEX IF EXISTS api_keys_group_idx;
ALTER TABLE api_keys DROP COLUMN IF EXISTS group_id;

DROP TABLE IF EXISTS account_group_members;
DROP TABLE IF EXISTS account_groups;

COMMIT;

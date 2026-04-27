-- packages/db/drizzle/0005_down.sql
-- EMERGENCY ROLLBACK ONLY. Not auto-applied by drizzle migrator.
-- Run manually with: psql $DATABASE_URL -f packages/db/drizzle/0005_down.sql
-- After running, manually remove the 0005 entry from drizzle/meta/_journal.json
-- and delete drizzle/meta/0005_snapshot.json.

BEGIN;

DROP INDEX IF EXISTS "request_body_facets_prompt_version_idx";
DROP INDEX IF EXISTS "request_body_facets_org_extracted_idx";
DROP TABLE IF EXISTS "request_body_facets";

COMMIT;

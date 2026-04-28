-- packages/db/drizzle/0007_down.sql
-- EMERGENCY ROLLBACK ONLY. Not auto-applied by drizzle migrator.
-- Run manually with: psql $DATABASE_URL -f packages/db/drizzle/0007_down.sql
-- After running, manually remove the 0007 entry from drizzle/meta/_journal.json.
--
-- Reverses 0007_platform_rubric_v2_facets.sql by:
--   * Removing the two facet signals from sections[0].signals and
--     sections[1].signals (filtered by the well-known ids).
--   * Removing the matching ids from supportThresholds.
--   * Restoring the version to "1.0.0".

BEGIN;

DO $$
DECLARE
  r RECORD;
  d jsonb;
  s0_signals jsonb;
  s0_supports jsonb;
  s1_signals jsonb;
  s1_supports jsonb;
BEGIN
  FOR r IN
    SELECT id, definition
    FROM rubrics
    WHERE is_default = true AND org_id IS NULL
  LOOP
    d := r.definition;

    -- Filter out the facet signals we added in 0007.
    SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
      FROM jsonb_array_elements(d #> '{sections,0,signals}') AS elem
      WHERE elem->>'id' != 'facet_outcome_success'
      INTO s0_signals;

    SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
      FROM jsonb_array_elements(d #> '{sections,0,superiorRules,supportThresholds}') AS elem
      WHERE elem != '"facet_outcome_success"'::jsonb
      INTO s0_supports;

    SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
      FROM jsonb_array_elements(d #> '{sections,1,signals}') AS elem
      WHERE elem->>'id' != 'facet_bugs_caught'
      INTO s1_signals;

    SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
      FROM jsonb_array_elements(d #> '{sections,1,superiorRules,supportThresholds}') AS elem
      WHERE elem != '"facet_bugs_caught"'::jsonb
      INTO s1_supports;

    d := jsonb_set(d, '{version}', '"1.0.0"'::jsonb);
    d := jsonb_set(d, '{sections,0,signals}', s0_signals);
    d := jsonb_set(d, '{sections,0,superiorRules,supportThresholds}', s0_supports);
    d := jsonb_set(d, '{sections,1,signals}', s1_signals);
    d := jsonb_set(d, '{sections,1,superiorRules,supportThresholds}', s1_supports);

    UPDATE rubrics
    SET
      definition = d,
      version = '1.0.0',
      updated_at = now()
    WHERE id = r.id;
  END LOOP;
END $$;

COMMIT;

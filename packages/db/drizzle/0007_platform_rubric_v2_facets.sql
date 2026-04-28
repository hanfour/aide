-- 0007_platform_rubric_v2_facets.sql
-- Plan 4C follow-up #2: bumps the 3 platform-default rubrics
-- (en/zh-Hant/ja) from 1.0.0 → 1.1.0 by adding facet-based supports
-- to both sections.
--
-- Strictly additive design:
--   * No existing signals removed.
--   * No `minStrongHits` / `minSupportHits` thresholds changed.
--   * For orgs WITHOUT facet extraction: facet signals return `hit: false`
--     (gte aggregators) → support count is unchanged → no scoring change.
--   * For orgs WITH facet extraction: the new supports add additional
--     pathways to satisfy `minSupportHits` (still 1), so superior tier
--     becomes reachable for orgs whose existing support signals don't
--     hit but whose facet data is strong.
--
-- The new supports:
--   interaction.supportThresholds += "facet_outcome_success"
--     → facet_outcome_success_rate (gte: 0.5) — half of classified sessions
--       were success or partial.
--   riskControl.supportThresholds += "facet_bugs_caught"
--     → facet_bugs_caught (gte: 1) — at least one bug was caught.
--
-- Hand-written data migration; drizzle-kit doesn't generate data updates.

--> statement-breakpoint
DO $$
DECLARE
  r RECORD;
  d jsonb;
BEGIN
  FOR r IN
    SELECT id, definition
    FROM rubrics
    WHERE is_default = true AND org_id IS NULL
  LOOP
    d := r.definition;

    -- Bump version
    d := jsonb_set(d, '{version}', '"1.1.0"'::jsonb);

    -- Section 0 (interaction): append facet_outcome_success_rate signal
    d := jsonb_set(
      d,
      '{sections,0,signals}',
      (d #> '{sections,0,signals}')
        || '[{"type":"facet_outcome_success_rate","id":"facet_outcome_success","gte":0.5}]'::jsonb
    );
    -- … and reference it in supportThresholds
    d := jsonb_set(
      d,
      '{sections,0,superiorRules,supportThresholds}',
      (d #> '{sections,0,superiorRules,supportThresholds}')
        || '"facet_outcome_success"'::jsonb
    );

    -- Section 1 (riskControl): append facet_bugs_caught signal
    d := jsonb_set(
      d,
      '{sections,1,signals}',
      (d #> '{sections,1,signals}')
        || '[{"type":"facet_bugs_caught","id":"facet_bugs_caught","gte":1}]'::jsonb
    );
    -- … and reference it in supportThresholds
    d := jsonb_set(
      d,
      '{sections,1,superiorRules,supportThresholds}',
      (d #> '{sections,1,superiorRules,supportThresholds}')
        || '"facet_bugs_caught"'::jsonb
    );

    UPDATE rubrics
    SET
      definition = d,
      version = '1.1.0',
      updated_at = now()
    WHERE id = r.id;
  END LOOP;
END $$;

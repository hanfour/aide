ALTER TABLE "model_pricing" ADD COLUMN "cache_read_per_million_micros" bigint;
--> statement-breakpoint
-- PR #32 follow-up — backfill the documented Anthropic cache_read rates
-- so OAuth / apikey billing through computeCost stops overbilling at
-- the input rate.  Anthropic prompt-cache reads bill at ~10% of input
-- per official pricing pages (verified 2026-04-28; sync with
-- packages/db/src/seed/modelPricingSnapshot20260428.ts on update).
--
-- OpenAI rows stay NULL — the platform has no cache_read concept;
-- cached_input is billed via cached_input_per_million_micros instead.

UPDATE model_pricing
  SET cache_read_per_million_micros = 1500000  -- $1.50/M = 10% of $15/M input
  WHERE platform = 'anthropic' AND model_id = 'claude-opus-4-7';
--> statement-breakpoint
UPDATE model_pricing
  SET cache_read_per_million_micros = 300000   -- $0.30/M = 10% of $3/M input
  WHERE platform = 'anthropic' AND model_id = 'claude-sonnet-4-6';
--> statement-breakpoint
UPDATE model_pricing
  SET cache_read_per_million_micros = 100000   -- $0.10/M = 10% of $1/M input
  WHERE platform = 'anthropic' AND model_id = 'claude-haiku-4-5';
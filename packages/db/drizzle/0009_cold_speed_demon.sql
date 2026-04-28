CREATE TABLE IF NOT EXISTS "model_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"model_id" text NOT NULL,
	"input_per_million_micros" bigint NOT NULL,
	"output_per_million_micros" bigint NOT NULL,
	"cached_5m_per_million_micros" bigint,
	"cached_1h_per_million_micros" bigint,
	"cached_input_per_million_micros" bigint,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_pricing_active_idx" ON "model_pricing" USING btree ("platform","model_id","effective_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_pricing_lookup_idx" ON "model_pricing" USING btree ("platform","model_id","effective_from");
--> statement-breakpoint
-- Plan 5A §4.2 — hand-appended CHECK constraints + initial pricing seed.
-- Numbers verified against provider pricing pages on 2026-04-28; canonical
-- source mirrored in packages/db/src/seed/modelPricingSnapshot2026Q2.ts.

ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_platform_values"
  CHECK ("platform" IN ('anthropic', 'openai', 'gemini', 'antigravity'));
--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_effective_range"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");
--> statement-breakpoint
INSERT INTO model_pricing (platform, model_id,
  input_per_million_micros, output_per_million_micros,
  cached_5m_per_million_micros, cached_1h_per_million_micros, cached_input_per_million_micros,
  effective_from)
VALUES
  -- Anthropic — 5m / 1h prompt-cache pricing per Anthropic prompt-cache docs.
  ('anthropic', 'claude-opus-4-7',   15000000, 75000000, 18750000, 30000000, NULL, '2026-04-28T00:00:00Z'),
  ('anthropic', 'claude-sonnet-4-6',  3000000, 15000000,  3750000,  6000000, NULL, '2026-04-28T00:00:00Z'),
  ('anthropic', 'claude-haiku-4-5',   1000000,  5000000,  1250000,  2000000, NULL, '2026-04-28T00:00:00Z'),
  -- OpenAI — cached_input only; no 5m/1h split.
  ('openai',    'gpt-4o',             2500000, 10000000, NULL, NULL, 1250000, '2026-04-28T00:00:00Z'),
  ('openai',    'gpt-4o-mini',         150000,   600000, NULL, NULL,   75000, '2026-04-28T00:00:00Z'),
  ('openai',    'o1',                15000000, 60000000, NULL, NULL, 7500000, '2026-04-28T00:00:00Z'),
  ('openai',    'o1-mini',            3000000, 12000000, NULL, NULL, 1500000, '2026-04-28T00:00:00Z');
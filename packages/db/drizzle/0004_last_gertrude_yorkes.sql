CREATE TABLE IF NOT EXISTS "llm_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"model" text NOT NULL,
	"tokens_input" integer NOT NULL,
	"tokens_output" integer NOT NULL,
	"cost_usd" numeric(10, 6) NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "llm_facet_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "llm_facet_model" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "llm_monthly_budget_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "llm_budget_overage_behavior" text DEFAULT 'degrade' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "llm_halted_until_month_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_usage_org_month_idx" ON "llm_usage_events" USING btree ("org_id","created_at");
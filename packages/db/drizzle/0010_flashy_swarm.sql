ALTER TABLE "usage_logs" ADD COLUMN "cache_creation_5m_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "cache_creation_1h_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "cached_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "cached_input_cost" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "actual_cost_usd" numeric(20, 10) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "group_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_group_id_account_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."account_groups"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_logs_group_time_idx" ON "usage_logs" USING btree ("group_id","created_at");
CREATE TABLE IF NOT EXISTS "rubrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"version" text NOT NULL,
	"definition" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "request_bodies" (
	"request_id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"request_body_sealed" "bytea" NOT NULL,
	"response_body_sealed" "bytea" NOT NULL,
	"thinking_body_sealed" "bytea",
	"attempt_errors_sealed" "bytea",
	"request_params" jsonb,
	"stop_reason" text,
	"client_user_agent" text,
	"client_session_id" text,
	"attachments_meta" jsonb,
	"cache_control_markers" jsonb,
	"tool_result_truncated" boolean DEFAULT false NOT NULL,
	"body_truncated" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evaluation_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"period_type" text NOT NULL,
	"rubric_id" uuid NOT NULL,
	"rubric_version" text NOT NULL,
	"total_score" numeric(10, 4) NOT NULL,
	"section_scores" jsonb NOT NULL,
	"signals_summary" jsonb NOT NULL,
	"data_quality" jsonb NOT NULL,
	"llm_narrative" text,
	"llm_evidence" jsonb,
	"llm_model" text,
	"llm_called_at" timestamp with time zone,
	"llm_cost_usd" numeric(20, 10),
	"llm_upstream_account_id" uuid,
	"triggered_by" text NOT NULL,
	"triggered_by_user" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gdpr_delete_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_user_id" uuid,
	"reason" text,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_reason" text,
	"executed_at" timestamp with time zone,
	"scope" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "content_capture_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "content_capture_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "content_capture_enabled_by" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "retention_days_override" integer;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "llm_eval_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "llm_eval_account_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "llm_eval_model" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "capture_thinking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "rubric_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "leaderboard_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rubrics" ADD CONSTRAINT "rubrics_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rubrics" ADD CONSTRAINT "rubrics_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_bodies" ADD CONSTRAINT "request_bodies_request_id_usage_logs_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."usage_logs"("request_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_bodies" ADD CONSTRAINT "request_bodies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_rubric_id_rubrics_id_fk" FOREIGN KEY ("rubric_id") REFERENCES "public"."rubrics"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_llm_upstream_account_id_upstream_accounts_id_fk" FOREIGN KEY ("llm_upstream_account_id") REFERENCES "public"."upstream_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evaluation_reports" ADD CONSTRAINT "evaluation_reports_triggered_by_user_users_id_fk" FOREIGN KEY ("triggered_by_user") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gdpr_delete_requests" ADD CONSTRAINT "gdpr_delete_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gdpr_delete_requests" ADD CONSTRAINT "gdpr_delete_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gdpr_delete_requests" ADD CONSTRAINT "gdpr_delete_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gdpr_delete_requests" ADD CONSTRAINT "gdpr_delete_requests_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rubrics_org_idx" ON "rubrics" USING btree ("org_id") WHERE "rubrics"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rubrics_default_idx" ON "rubrics" USING btree ("is_default") WHERE "rubrics"."is_default" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_bodies_retention_idx" ON "request_bodies" USING btree ("retention_until");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_bodies_org_time_idx" ON "request_bodies" USING btree ("org_id","captured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_reports_user_time_idx" ON "evaluation_reports" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_reports_org_time_idx" ON "evaluation_reports" USING btree ("org_id","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluation_reports_team_time_idx" ON "evaluation_reports" USING btree ("team_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evaluation_reports_period_uniq" ON "evaluation_reports" USING btree ("user_id","period_start","period_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gdpr_delete_requests_pending_idx" ON "gdpr_delete_requests" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gdpr_delete_requests_approved_idx" ON "gdpr_delete_requests" USING btree ("approved_at");
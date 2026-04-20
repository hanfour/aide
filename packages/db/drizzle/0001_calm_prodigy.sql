CREATE TABLE IF NOT EXISTS "upstream_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"name" text NOT NULL,
	"notes" text,
	"platform" text NOT NULL,
	"type" text NOT NULL,
	"schedulable" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"concurrency" integer DEFAULT 3 NOT NULL,
	"rate_multiplier" numeric(10, 4) DEFAULT '1.0' NOT NULL,
	"rate_limited_at" timestamp with time zone,
	"rate_limit_reset_at" timestamp with time zone,
	"overload_until" timestamp with time zone,
	"temp_unschedulable_until" timestamp with time zone,
	"temp_unschedulable_reason" text,
	"last_used_at" timestamp with time zone,
	"oauth_refresh_fail_count" integer DEFAULT 0 NOT NULL,
	"oauth_refresh_last_error" text,
	"oauth_refresh_last_run_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"auto_pause_on_expired" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credential_vault" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"oauth_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "credential_vault_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ip_whitelist" text[],
	"ip_blacklist" text[],
	"quota_usd" numeric(20, 8) DEFAULT '0' NOT NULL,
	"quota_used_usd" numeric(20, 8) DEFAULT '0' NOT NULL,
	"rate_limit_1d_usd" numeric(20, 8) DEFAULT '0' NOT NULL,
	"issued_by_user_id" uuid,
	"reveal_token_hash" text,
	"reveal_token_expires_at" timestamp with time zone,
	"revealed_at" timestamp with time zone,
	"revealed_by_ip" "inet",
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"requested_model" text NOT NULL,
	"upstream_model" text NOT NULL,
	"platform" text NOT NULL,
	"surface" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"input_cost" numeric(20, 10) DEFAULT '0' NOT NULL,
	"output_cost" numeric(20, 10) DEFAULT '0' NOT NULL,
	"cache_creation_cost" numeric(20, 10) DEFAULT '0' NOT NULL,
	"cache_read_cost" numeric(20, 10) DEFAULT '0' NOT NULL,
	"total_cost" numeric(20, 10) DEFAULT '0' NOT NULL,
	"rate_multiplier" numeric(10, 4) DEFAULT '1.0' NOT NULL,
	"account_rate_multiplier" numeric(10, 4) DEFAULT '1.0' NOT NULL,
	"stream" boolean DEFAULT false NOT NULL,
	"status_code" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"first_token_ms" integer,
	"buffer_released_at_ms" integer,
	"upstream_retries" integer DEFAULT 0 NOT NULL,
	"failed_account_ids" uuid[],
	"user_agent" text,
	"ip_address" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_logs_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "upstream_accounts" ADD CONSTRAINT "upstream_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "upstream_accounts" ADD CONSTRAINT "upstream_accounts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credential_vault" ADD CONSTRAINT "credential_vault_account_id_upstream_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."upstream_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_account_id_upstream_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."upstream_accounts"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upstream_accounts_scope_idx" ON "upstream_accounts" USING btree ("org_id","team_id") WHERE "upstream_accounts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upstream_accounts_select_idx" ON "upstream_accounts" USING btree ("org_id","team_id","priority") WHERE "upstream_accounts"."deleted_at" IS NULL AND "upstream_accounts"."schedulable" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credential_vault_oauth_expiry_idx" ON "credential_vault" USING btree ("oauth_expires_at") WHERE "credential_vault"."oauth_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_user_idx" ON "api_keys" USING btree ("user_id") WHERE "api_keys"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_org_idx" ON "api_keys" USING btree ("org_id") WHERE "api_keys"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_reveal_idx" ON "api_keys" USING btree ("reveal_token_hash") WHERE "api_keys"."reveal_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_logs_user_time_idx" ON "usage_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_logs_api_key_time_idx" ON "usage_logs" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_logs_account_time_idx" ON "usage_logs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_logs_org_time_idx" ON "usage_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_logs_team_time_idx" ON "usage_logs" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_logs_model_idx" ON "usage_logs" USING btree ("requested_model");
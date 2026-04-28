CREATE TABLE IF NOT EXISTS "account_group_members" (
	"account_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_group_members_account_id_group_id_pk" PRIMARY KEY("account_id","group_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"platform" text NOT NULL,
	"rate_multiplier" numeric(10, 4) DEFAULT '1.0' NOT NULL,
	"is_exclusive" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "account_groups_org_name_unique" UNIQUE("org_id","name")
);
--> statement-breakpoint
ALTER TABLE "upstream_accounts" ADD COLUMN "subscription_tier" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "group_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_group_members" ADD CONSTRAINT "account_group_members_account_id_upstream_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."upstream_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_group_members" ADD CONSTRAINT "account_group_members_group_id_account_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."account_groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_group_members_group_priority_idx" ON "account_group_members" USING btree ("group_id","priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_groups_org_platform_idx" ON "account_groups" USING btree ("org_id","platform") WHERE "account_groups"."deleted_at" IS NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_group_id_account_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."account_groups"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_group_idx" ON "api_keys" USING btree ("group_id") WHERE "api_keys"."revoked_at" IS NULL AND "api_keys"."group_id" IS NOT NULL;
--> statement-breakpoint
-- Plan 5A §4.1 — hand-appended CHECK constraints (drizzle-kit 0.28 cannot
-- generate them) and backfill DO block. Indexes + UNIQUE are now declared
-- in Drizzle schema (accountGroups.ts, apiKeys.ts) so drizzle-kit emits
-- them inline above.

ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_platform_values"
  CHECK ("platform" IN ('anthropic', 'openai', 'gemini', 'antigravity'));
--> statement-breakpoint
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_status_values"
  CHECK ("status" IN ('active', 'disabled'));
--> statement-breakpoint
ALTER TABLE "upstream_accounts" ADD CONSTRAINT "subscription_tier_values"
  CHECK (
    "subscription_tier" IS NULL
    OR "subscription_tier" IN ('free', 'plus', 'pro', 'team', 'enterprise')
  );
--> statement-breakpoint
-- Backfill: per-org legacy-anthropic group + migrate existing accounts and
-- unassigned api_keys into it. Runs once via _journal.json registration; not
-- guarded by ON CONFLICT (would mask half-applied state).
DO $$
DECLARE
  v_org_id UUID;
  v_group_id UUID;
BEGIN
  FOR v_org_id IN
    SELECT DISTINCT org_id FROM upstream_accounts
    WHERE platform = 'anthropic' AND deleted_at IS NULL
  LOOP
    INSERT INTO account_groups (org_id, name, platform, description)
    VALUES (
      v_org_id,
      'legacy-anthropic',
      'anthropic',
      'Auto-created during 5A migration; reorganise in admin UI'
    )
    RETURNING id INTO v_group_id;

    INSERT INTO account_group_members (account_id, group_id, priority)
    SELECT id, v_group_id, priority
    FROM upstream_accounts
    WHERE org_id = v_org_id AND platform = 'anthropic' AND deleted_at IS NULL;

    UPDATE api_keys SET group_id = v_group_id
    WHERE org_id = v_org_id AND group_id IS NULL AND revoked_at IS NULL;
  END LOOP;
END $$;
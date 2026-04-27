CREATE TABLE IF NOT EXISTS "request_body_facets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"session_type" text,
	"outcome" text,
	"claude_helpfulness" smallint,
	"friction_count" integer,
	"bugs_caught_count" integer,
	"codex_errors_count" integer,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"extracted_with_model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"extraction_error" text,
	CONSTRAINT "request_body_facets_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_body_facets" ADD CONSTRAINT "request_body_facets_request_id_request_bodies_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request_bodies"("request_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_body_facets" ADD CONSTRAINT "request_body_facets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_body_facets_org_extracted_idx" ON "request_body_facets" USING btree ("org_id","extracted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_body_facets_prompt_version_idx" ON "request_body_facets" USING btree ("prompt_version");
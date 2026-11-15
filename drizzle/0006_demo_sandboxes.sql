CREATE TABLE "demo_sandboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"profile_id" text,
	"admin_user_id" text NOT NULL,
	"caregiver_user_id" text NOT NULL,
	"other_caregiver_user_id" text NOT NULL,
	"elder_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_sandboxes_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "demo_sandboxes" ADD CONSTRAINT "demo_sandboxes_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demo_sandboxes_created_idx" ON "demo_sandboxes" USING btree ("created_at");
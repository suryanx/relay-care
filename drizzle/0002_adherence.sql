CREATE TABLE "dose_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"dose_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"type" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"source" text NOT NULL,
	"actor_user_id" text,
	"note" text,
	"occurred_at" timestamp with time zone,
	"correction_of" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "help_requests" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"profile_id" text NOT NULL,
	"dose_id" text,
	"requested_by" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doses" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "doses" ADD COLUMN "outcome_source" text;--> statement-breakpoint
ALTER TABLE "doses" ADD COLUMN "outcome_recorded_by" text;--> statement-breakpoint
ALTER TABLE "doses" ADD COLUMN "outcome_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doses" ADD COLUMN "outcome_occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doses" ADD COLUMN "outcome_note" text;--> statement-breakpoint
ALTER TABLE "doses" ADD COLUMN "snooze_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "doses" ADD COLUMN "snooze_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "grace_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "dose_events" ADD CONSTRAINT "dose_events_dose_id_doses_id_fk" FOREIGN KEY ("dose_id") REFERENCES "public"."doses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dose_events" ADD CONSTRAINT "dose_events_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dose_events" ADD CONSTRAINT "dose_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_dose_id_doses_id_fk" FOREIGN KEY ("dose_id") REFERENCES "public"."doses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dose_events_dose_idx" ON "dose_events" USING btree ("dose_id");--> statement-breakpoint
CREATE INDEX "dose_events_profile_recorded_idx" ON "dose_events" USING btree ("profile_id","recorded_at");--> statement-breakpoint
CREATE INDEX "help_requests_profile_idx" ON "help_requests" USING btree ("profile_id","status");--> statement-breakpoint
ALTER TABLE "doses" ADD CONSTRAINT "doses_outcome_recorded_by_user_id_fk" FOREIGN KEY ("outcome_recorded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doses_profile_status_idx" ON "doses" USING btree ("profile_id","status");
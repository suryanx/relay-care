CREATE TABLE "notifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"dedupe_key" text NOT NULL,
	"profile_id" text NOT NULL,
	"type" text NOT NULL,
	"recipient_user_id" text,
	"subject" text NOT NULL,
	"preview" text NOT NULL,
	"dose_id" text,
	"appointment_id" text,
	"help_request_id" text,
	"due_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"last_error" text,
	"cancel_reason" text,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "sweep_locks" (
	"id" text PRIMARY KEY NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"holder" text
);
--> statement-breakpoint
CREATE TABLE "sweep_runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"trigger" text NOT NULL,
	"profile_id" text,
	"triggered_by" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" text
);
--> statement-breakpoint
ALTER TABLE "profile_members" ADD COLUMN "notify_dose_reminders" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_members" ADD COLUMN "notify_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_members" ADD COLUMN "notify_appointments" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sweep_runs" ADD CONSTRAINT "sweep_runs_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sweep_runs" ADD CONSTRAINT "sweep_runs_triggered_by_user_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_status_next_idx" ON "notifications" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notifications_profile_created_idx" ON "notifications" USING btree ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "sweep_runs_profile_started_idx" ON "sweep_runs" USING btree ("profile_id","started_at");
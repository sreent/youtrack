CREATE TABLE IF NOT EXISTS "timesheet_weeks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"week" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approved_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timesheet_weeks_person_week" UNIQUE("user_id","week")
);

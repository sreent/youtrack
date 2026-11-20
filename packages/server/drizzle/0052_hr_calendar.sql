ALTER TABLE "absences" ADD COLUMN "source" text DEFAULT 'entered' NOT NULL;
--> statement-breakpoint
ALTER TABLE "absences" ADD COLUMN "external_id" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "hr_calendar" text;

ALTER TABLE "rules" ADD COLUMN "queued" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "script_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"project_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"origin" text,
	"input" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "script_jobs_once" ON "script_jobs" ("rule_id","issue_id","origin");

CREATE TABLE "vcs_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"repository" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"branch" text,
	"state" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text,
	"commit_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"commits_of" text,
	"mentioned" text[] DEFAULT '{}'::text[] NOT NULL,
	"issue_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"check_run_id" text,
	"check_sha" text,
	"written" text,
	"conclusion" text,
	"written_at" timestamp with time zone,
	"marks" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"problem" text,
	"problem_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vcs_installations" (
	"integration_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"account" text,
	"account_type" text,
	"repository_selection" text,
	"suspended_at" timestamp with time zone,
	"gone_at" timestamp with time zone,
	"repositories" text[] DEFAULT '{}'::text[] NOT NULL,
	"checks_window_at" timestamp with time zone,
	"checks_in_window" integer DEFAULT 0 NOT NULL,
	"checks_paused_until" timestamp with time zone,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vcs_installations_integration_id_installation_id_pk" PRIMARY KEY("integration_id","installation_id")
);
--> statement-breakpoint
ALTER TABLE "vcs_integrations" ADD COLUMN "checks" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vcs_integrations" ADD COLUMN "checks_states" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vcs_integrations" ADD COLUMN "checks_resolved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vcs_checks" ADD CONSTRAINT "vcs_checks_integration_id_vcs_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."vcs_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_installations" ADD CONSTRAINT "vcs_installations_integration_id_vcs_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."vcs_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_checks_pull" ON "vcs_checks" USING btree ("integration_id","repository","number");--> statement-breakpoint
CREATE INDEX "vcs_checks_due" ON "vcs_checks" USING btree ("due_at");
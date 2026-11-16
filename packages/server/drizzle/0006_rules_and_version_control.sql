CREATE TABLE "rule_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"project_id" text,
	"issue_id" text,
	"issue_key" text,
	"event_id" bigint,
	"origin_id" text,
	"actor_id" text,
	"outcome" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"changes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"trigger" text,
	"trigger_field" text,
	"schedule" jsonb,
	"query" text DEFAULT '' NOT NULL,
	"command" text DEFAULT '' NOT NULL,
	"comment" text,
	"requires" text,
	"message" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_id" text,
	"updated_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vcs_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"delivery_id" text,
	"event" text NOT NULL,
	"outcome" text NOT NULL,
	"status_code" integer NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"linked" integer DEFAULT 0 NOT NULL,
	"applied" integer DEFAULT 0 NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vcs_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"project_ids" text[] NOT NULL,
	"signing_key" text,
	"token_hash" text,
	"secret_prefix" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_delivery_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vcs_links" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text,
	"issue_id" text NOT NULL,
	"kind" text NOT NULL,
	"repository" text NOT NULL,
	"ref" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"url" text,
	"branch" text,
	"target_branch" text,
	"state" text,
	"author_name" text,
	"author_login" text,
	"author_email" text,
	"author_id" text,
	"command" text,
	"command_applied" boolean,
	"command_note" text,
	"happened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rule_runs" ADD CONSTRAINT "rule_runs_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_runs" ADD CONSTRAINT "rule_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_runs" ADD CONSTRAINT "rule_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_runs" ADD CONSTRAINT "rule_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_deliveries" ADD CONSTRAINT "vcs_deliveries_integration_id_vcs_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."vcs_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_integrations" ADD CONSTRAINT "vcs_integrations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_links" ADD CONSTRAINT "vcs_links_integration_id_vcs_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."vcs_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_links" ADD CONSTRAINT "vcs_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_links" ADD CONSTRAINT "vcs_links_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rule_runs_rule" ON "rule_runs" USING btree ("rule_id","id");--> statement-breakpoint
CREATE INDEX "rule_runs_project" ON "rule_runs" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "rule_runs_created" ON "rule_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rule_runs_once" ON "rule_runs" USING btree ("rule_id","issue_id","origin_id") WHERE "rule_runs"."origin_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "rules_project" ON "rules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "rules_due" ON "rules" USING btree ("kind","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_deliveries_once" ON "vcs_deliveries" USING btree ("integration_id","delivery_id") WHERE "vcs_deliveries"."delivery_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "vcs_deliveries_recent" ON "vcs_deliveries" USING btree ("integration_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_links_once" ON "vcs_links" USING btree ("issue_id","kind","repository","ref");--> statement-breakpoint
CREATE INDEX "vcs_links_ref" ON "vcs_links" USING btree ("kind","repository","ref");
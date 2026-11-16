CREATE TABLE "build_issues" (
	"build_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"outcome" text NOT NULL,
	"note" text,
	"commit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "build_issues_build_id_issue_id_pk" PRIMARY KEY("build_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "build_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"project_id" text NOT NULL,
	"field_id" text,
	"vcs_integration_id" text,
	"branch" text,
	"workflow" text,
	"token_hash" text,
	"token_prefix" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_build_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text,
	"project_id" text NOT NULL,
	"field_id" text,
	"value_id" text,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"url" text,
	"repository" text,
	"branch" text,
	"head_sha" text,
	"head_at" timestamp with time zone,
	"commits" text[] DEFAULT '{}'::text[] NOT NULL,
	"marked" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_link_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"verifier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_logins" ADD COLUMN "provider_user_id" text;--> statement-breakpoint
ALTER TABLE "build_issues" ADD CONSTRAINT "build_issues_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_issues" ADD CONSTRAINT "build_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_sources" ADD CONSTRAINT "build_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_sources" ADD CONSTRAINT "build_sources_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_sources" ADD CONSTRAINT "build_sources_vcs_integration_id_vcs_integrations_id_fk" FOREIGN KEY ("vcs_integration_id") REFERENCES "public"."vcs_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_sources" ADD CONSTRAINT "build_sources_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_source_id_build_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."build_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_value_id_field_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."field_values"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_link_states" ADD CONSTRAINT "provider_link_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_issues_issue" ON "build_issues" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "builds_once" ON "builds" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "builds_recent" ON "builds" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "builds_source" ON "builds" USING btree ("source_id","branch","created_at");
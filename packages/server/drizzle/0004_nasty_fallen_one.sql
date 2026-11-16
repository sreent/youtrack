CREATE TABLE "dashboards" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"widgets" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_issues" (
	"project_id" text NOT NULL,
	"source" text NOT NULL,
	"external_key" text NOT NULL,
	"external_id" text,
	"issue_id" text,
	"readable_id" text NOT NULL,
	"created_by_import_id" text,
	"last_import_id" text,
	"values" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_issues_project_id_source_external_key_pk" PRIMARY KEY("project_id","source","external_key")
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"import_id" text NOT NULL,
	"n" integer NOT NULL,
	"cells" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"issue_id" text,
	"readable_id" text,
	"problems" jsonb,
	CONSTRAINT "import_rows_import_id_n_pk" PRIMARY KEY("import_id","n")
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"source" text NOT NULL,
	"file_name" text NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"header" jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"mapping" jsonb NOT NULL,
	"progress_phase" text,
	"progress_done" integer DEFAULT 0 NOT NULL,
	"progress_total" integer DEFAULT 0 NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"result" jsonb
);
--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_issues" ADD CONSTRAINT "external_issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_issues" ADD CONSTRAINT "external_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboards_owner" ON "dashboards" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "external_issues_issue" ON "external_issues" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "external_issues_import" ON "external_issues" USING btree ("created_by_import_id");--> statement-breakpoint
CREATE INDEX "external_issues_external_id" ON "external_issues" USING btree ("project_id","source","external_id");--> statement-breakpoint
CREATE INDEX "imports_project" ON "imports" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "activities_sprint" ON "activities" USING btree (("payload"->'data'->>'sprintId'),"id") WHERE "activities"."type" in ('sprint.issue_added', 'sprint.issue_removed');
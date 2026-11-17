CREATE TABLE "app_files" (
	"app_id" text NOT NULL,
	"path" text NOT NULL,
	"content_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	CONSTRAINT "app_files_app_id_path_pk" PRIMARY KEY("app_id","path")
);
--> statement-breakpoint
CREATE TABLE "app_projects" (
	"app_id" text NOT NULL,
	"project_id" text NOT NULL,
	"chosen" boolean DEFAULT false NOT NULL,
	"off" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_projects_app_id_project_id_pk" PRIMARY KEY("app_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "app_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"handler" text NOT NULL,
	"actor_id" text,
	"project_id" text,
	"issue_key" text,
	"outcome" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"project_id" text,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_storage" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"project_id" text,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"version" text NOT NULL,
	"vendor" text,
	"description" text DEFAULT '' NOT NULL,
	"manifest" jsonb NOT NULL,
	"granted" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"source" jsonb NOT NULL,
	"agent_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"all_projects" boolean DEFAULT false NOT NULL,
	"installed_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "app_id" text;--> statement-breakpoint
ALTER TABLE "app_files" ADD CONSTRAINT "app_files_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_projects" ADD CONSTRAINT "app_projects_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_projects" ADD CONSTRAINT "app_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_runs" ADD CONSTRAINT "app_runs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_runs" ADD CONSTRAINT "app_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_runs" ADD CONSTRAINT "app_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_storage" ADD CONSTRAINT "app_storage_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_storage" ADD CONSTRAINT "app_storage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_installed_by_id_users_id_fk" FOREIGN KEY ("installed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_runs_app" ON "app_runs" USING btree ("app_id","id");--> statement-breakpoint
CREATE INDEX "app_runs_created" ON "app_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_settings_app" ON "app_settings" USING btree ("app_id") WHERE "app_settings"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "app_settings_project" ON "app_settings" USING btree ("app_id","project_id") WHERE "app_settings"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "app_storage_app_key" ON "app_storage" USING btree ("app_id","key") WHERE "app_storage"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "app_storage_project_key" ON "app_storage" USING btree ("app_id","project_id","key") WHERE "app_storage"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "apps_name" ON "apps" USING btree ("name");--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
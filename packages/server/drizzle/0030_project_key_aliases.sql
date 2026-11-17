CREATE TABLE "project_key_aliases" (
	"key" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"renamed_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_key_aliases" ADD CONSTRAINT "project_key_aliases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_key_aliases" ADD CONSTRAINT "project_key_aliases_renamed_by_id_users_id_fk" FOREIGN KEY ("renamed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_key_aliases_project" ON "project_key_aliases" USING btree ("project_id");
CREATE TABLE "issue_aliases" (
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"issue_id" text NOT NULL,
	"moved_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_aliases_project_id_number_pk" PRIMARY KEY("project_id","number")
);
--> statement-breakpoint
CREATE TABLE "issue_votes" (
	"issue_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_votes_issue_id_user_id_pk" PRIMARY KEY("issue_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"emoji" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reactions_target_kind_target_id_emoji_user_id_pk" PRIMARY KEY("target_kind","target_id","emoji","user_id")
);
--> statement-breakpoint
ALTER TABLE "field_values" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "issue_field_values" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "issue_field_values" ADD COLUMN "time_value" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "votes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_fields" ADD COLUMN "condition" text;--> statement-breakpoint
ALTER TABLE "issue_aliases" ADD CONSTRAINT "issue_aliases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_aliases" ADD CONSTRAINT "issue_aliases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_aliases" ADD CONSTRAINT "issue_aliases_moved_by_id_users_id_fk" FOREIGN KEY ("moved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_votes" ADD CONSTRAINT "issue_votes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_votes" ADD CONSTRAINT "issue_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_aliases_issue" ON "issue_aliases" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_votes_user" ON "issue_votes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reactions_issue" ON "reactions" USING btree ("issue_id");--> statement-breakpoint
ALTER TABLE "field_values" ADD CONSTRAINT "field_values_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_field_values" ADD CONSTRAINT "issue_field_values_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ifv_field_group" ON "issue_field_values" USING btree ("field_id","group_id");
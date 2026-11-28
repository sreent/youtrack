-- Planning as views of one search (D72): a saved search keeps its view and a version, and a shared one
-- outlives its owner; a saved search orders its own rows; undo records take a person's edits in a view;
-- a baseline belongs to a project or to a saved search; plans know the dependency type by a flag. Two
-- backfills were added to what drizzle-kit generated, each said where it is.
CREATE TABLE "search_ranks" (
	"saved_search_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"key" text COLLATE "C" NOT NULL,
	CONSTRAINT "search_ranks_saved_search_id_issue_id_pk" PRIMARY KEY("saved_search_id","issue_id")
);
--> statement-breakpoint
ALTER TABLE "saved_searches" DROP CONSTRAINT "saved_searches_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "baselines" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_searches" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_changes" ADD COLUMN "kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_changes" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "agent_changes" ADD COLUMN "view" text;--> statement-breakpoint
ALTER TABLE "baseline_tasks" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "baselines" ADD COLUMN "saved_search_id" text;--> statement-breakpoint
ALTER TABLE "link_types" ADD COLUMN "dependency" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: the dependency is the type whose outward phrase is "depends on", as plans have read it
-- (the seed's Depend); should several have it, the first in the types' order.
UPDATE "link_types" SET "dependency" = true WHERE "id" = (SELECT "id" FROM "link_types" WHERE lower("outward") = 'depends on' ORDER BY "ordinal", "id" LIMIT 1);--> statement-breakpoint
ALTER TABLE "saved_searches" ADD COLUMN "view" jsonb DEFAULT '{"kind":"list"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "search_ranks" ADD CONSTRAINT "search_ranks_saved_search_id_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."saved_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_ranks" ADD CONSTRAINT "search_ranks_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_ranks_key" ON "search_ranks" USING btree ("saved_search_id","key");--> statement-breakpoint
ALTER TABLE "baseline_tasks" ADD CONSTRAINT "baseline_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: every baseline so far is a project's, and each of its tasks was in that project.
UPDATE "baseline_tasks" t SET "project_id" = b."project_id" FROM "baselines" b WHERE b."id" = t."baseline_id";--> statement-breakpoint
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_saved_search_id_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."saved_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_changes_group" ON "agent_changes" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "baselines_saved_search" ON "baselines" USING btree ("saved_search_id");--> statement-breakpoint
CREATE UNIQUE INDEX "link_types_dependency" ON "link_types" USING btree ("dependency") WHERE "link_types"."dependency";--> statement-breakpoint
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_kind" CHECK ("agent_changes"."kind" IN ('agent', 'view'));--> statement-breakpoint
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_one_scope" CHECK (("baselines"."project_id" IS NULL) <> ("baselines"."saved_search_id" IS NULL));
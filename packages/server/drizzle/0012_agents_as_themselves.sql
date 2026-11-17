CREATE TABLE "agent_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"activity_id" bigint NOT NULL,
	"pair_activity_id" bigint,
	"undo" jsonb NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_activity_id" bigint,
	"undone_by_id" text,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_changes" ADD CONSTRAINT "agent_changes_undone_by_id_users_id_fk" FOREIGN KEY ("undone_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_changes_activity" ON "agent_changes" USING btree ("activity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_changes_pair" ON "agent_changes" USING btree ("pair_activity_id");--> statement-breakpoint
CREATE INDEX "agent_changes_issue" ON "agent_changes" USING btree ("issue_id");
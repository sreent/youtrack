CREATE TABLE "chat_issue_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text,
	"platform" text NOT NULL,
	"workspace_id" text,
	"workspace_name" text NOT NULL,
	"channel_id" text,
	"channel_name" text NOT NULL,
	"message_ref" text NOT NULL,
	"thread_ref" text NOT NULL,
	"url" text,
	"author_name" text NOT NULL,
	"author_external_id" text,
	"author_user_id" text,
	"sent_at" timestamp with time zone,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"more_files" integer DEFAULT 0 NOT NULL,
	"replies" integer DEFAULT 0 NOT NULL,
	"cut" boolean DEFAULT false NOT NULL,
	"created_by_id" text,
	"created_by_external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"made_at" timestamp with time zone,
	CONSTRAINT "chat_issue_sources_issue_id_unique" UNIQUE("issue_id")
);
--> statement-breakpoint
CREATE TABLE "chat_requests_seen" (
	"key" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_issue_sources" ADD CONSTRAINT "chat_issue_sources_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_issue_sources" ADD CONSTRAINT "chat_issue_sources_workspace_id_chat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."chat_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_issue_sources" ADD CONSTRAINT "chat_issue_sources_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_issue_sources" ADD CONSTRAINT "chat_issue_sources_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_issue_sources" ADD CONSTRAINT "chat_issue_sources_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_issue_sources_made" ON "chat_issue_sources" USING btree ("created_by_id","made_at");--> statement-breakpoint
CREATE INDEX "chat_issue_sources_expires" ON "chat_issue_sources" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "chat_requests_seen_expires" ON "chat_requests_seen" USING btree ("expires_at");
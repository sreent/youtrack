CREATE TABLE IF NOT EXISTS "chat_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"message_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_posts_channel_issue" ON "chat_posts" ("channel_id","issue_id");

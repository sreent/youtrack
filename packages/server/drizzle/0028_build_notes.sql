ALTER TABLE "build_issues" ADD COLUMN "said" jsonb;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD COLUMN "gone_said" jsonb;--> statement-breakpoint
ALTER TABLE "chat_subscriptions" ADD COLUMN "ended_said" jsonb;--> statement-breakpoint
ALTER TABLE "chat_workspaces" ADD COLUMN "removed_said" jsonb;
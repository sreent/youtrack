ALTER TABLE "attachments" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "whiteboard_id" text;
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_one_owner";
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_one_owner" CHECK (((issue_id IS NOT NULL AND article_id IS NULL AND whiteboard_id IS NULL) OR (issue_id IS NULL AND article_id IS NOT NULL AND whiteboard_id IS NULL) OR (issue_id IS NULL AND article_id IS NULL AND whiteboard_id IS NOT NULL)) AND (comment_id IS NULL OR issue_id IS NOT NULL) AND (project_id IS NOT NULL OR whiteboard_id IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "whiteboard_elements" ADD COLUMN "points" text;
--> statement-breakpoint
ALTER TABLE "whiteboard_elements" ADD COLUMN "attachment_id" text;

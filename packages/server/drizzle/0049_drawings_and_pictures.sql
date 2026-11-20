ALTER TABLE "attachments" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "whiteboard_id" text;
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_one_owner";
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_one_owner" CHECK (("attachments"."issue_id" IS NULL) <> ("attachments"."article_id" IS NULL) AND ("attachments"."issue_id" IS NULL) <> ("attachments"."whiteboard_id" IS NULL) AND ("attachments"."comment_id" IS NULL OR "attachments"."issue_id" IS NOT NULL) AND ("attachments"."project_id" IS NOT NULL OR "attachments"."whiteboard_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "whiteboard_elements" ADD COLUMN "points" text;
--> statement-breakpoint
ALTER TABLE "whiteboard_elements" ADD COLUMN "attachment_id" text;

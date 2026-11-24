ALTER TABLE "work_items" ALTER COLUMN "issue_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "activity" text;

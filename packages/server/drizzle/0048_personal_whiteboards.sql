ALTER TABLE "whiteboards" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "whiteboards" ADD COLUMN "share" text DEFAULT 'everyone' NOT NULL;
--> statement-breakpoint
ALTER TABLE "whiteboards" ADD COLUMN "shared_with" jsonb DEFAULT '{"people":[],"groups":[]}'::jsonb NOT NULL;

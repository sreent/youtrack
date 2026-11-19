ALTER TABLE "comments" ADD COLUMN "ai_drafted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "description_ai_drafted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "ai_drafted" boolean DEFAULT false NOT NULL;

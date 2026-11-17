ALTER TABLE "articles" ADD COLUMN "limited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "visible_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "visible_group_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "activities_article_gone" ON "activities" USING btree ("project_id") WHERE "activities"."type" = 'article.deleted' and "activities"."payload"->'data'->>'limited' = 'true';--> statement-breakpoint
CREATE INDEX "articles_limited" ON "articles" USING btree ("project_id") WHERE "articles"."limited";
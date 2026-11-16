CREATE TABLE "subscription_issues" (
	"subscription_id" text NOT NULL,
	"issue_id" text NOT NULL,
	CONSTRAINT "subscription_issues_subscription_id_issue_id_pk" PRIMARY KEY("subscription_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"saved_search_id" text,
	"events" text NOT NULL,
	"email" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_one_target" CHECK (("subscriptions"."project_id" IS NULL) <> ("subscriptions"."saved_search_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "subscription_issues" ADD CONSTRAINT "subscription_issues_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_issues" ADD CONSTRAINT "subscription_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_saved_search_id_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."saved_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_issues_issue" ON "subscription_issues" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_user_project" ON "subscriptions" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_user_search" ON "subscriptions" USING btree ("user_id","saved_search_id");--> statement-breakpoint
CREATE INDEX "subscriptions_project" ON "subscriptions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "subscriptions_search" ON "subscriptions" USING btree ("saved_search_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;
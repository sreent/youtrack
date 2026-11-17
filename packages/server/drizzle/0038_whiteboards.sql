CREATE TABLE "whiteboard_changes" (
	"whiteboard_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"actor_id" text,
	"client" text,
	"elements" jsonb NOT NULL,
	"removed" text[] DEFAULT '{}'::text[] NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whiteboard_changes_whiteboard_id_seq_pk" PRIMARY KEY("whiteboard_id","seq")
);
--> statement-breakpoint
CREATE TABLE "whiteboard_elements" (
	"whiteboard_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"w" double precision NOT NULL,
	"h" double precision NOT NULL,
	"z" double precision DEFAULT 0 NOT NULL,
	"text" text,
	"tone" text,
	"label" text,
	"from_id" text,
	"to_id" text,
	"issue_id" text,
	"article_id" text,
	"linked" text,
	"seq" bigint NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whiteboard_elements_whiteboard_id_id_pk" PRIMARY KEY("whiteboard_id","id")
);
--> statement-breakpoint
CREATE TABLE "whiteboard_viewers" (
	"whiteboard_id" text NOT NULL,
	"session" text NOT NULL,
	"user_id" text NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whiteboard_viewers_whiteboard_id_session_pk" PRIMARY KEY("whiteboard_id","session")
);
--> statement-breakpoint
CREATE TABLE "whiteboards" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whiteboard_changes" ADD CONSTRAINT "whiteboard_changes_whiteboard_id_whiteboards_id_fk" FOREIGN KEY ("whiteboard_id") REFERENCES "public"."whiteboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whiteboard_changes" ADD CONSTRAINT "whiteboard_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whiteboard_elements" ADD CONSTRAINT "whiteboard_elements_whiteboard_id_whiteboards_id_fk" FOREIGN KEY ("whiteboard_id") REFERENCES "public"."whiteboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whiteboard_elements" ADD CONSTRAINT "whiteboard_elements_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whiteboard_elements" ADD CONSTRAINT "whiteboard_elements_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whiteboard_elements" ADD CONSTRAINT "whiteboard_elements_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whiteboard_viewers" ADD CONSTRAINT "whiteboard_viewers_whiteboard_id_whiteboards_id_fk" FOREIGN KEY ("whiteboard_id") REFERENCES "public"."whiteboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whiteboard_viewers" ADD CONSTRAINT "whiteboard_viewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whiteboards" ADD CONSTRAINT "whiteboards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whiteboards" ADD CONSTRAINT "whiteboards_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whiteboard_elements_issue" ON "whiteboard_elements" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "whiteboard_elements_article" ON "whiteboard_elements" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "whiteboard_viewers_seen" ON "whiteboard_viewers" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "whiteboards_project" ON "whiteboards" USING btree ("project_id");
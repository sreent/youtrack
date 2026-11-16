CREATE TABLE "help_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"window_ends" timestamp with time zone NOT NULL,
	"hits" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_requests" (
	"issue_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_response_due_at" timestamp with time zone,
	"email_muted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "helpdesk_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_watchers" (
	"issue_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_watchers_issue_id_user_id_pk" PRIMARY KEY("issue_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "mail_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"message_id" text NOT NULL,
	"to_address" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "mail_outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"user_id" text NOT NULL,
	"event_id" bigint NOT NULL,
	"notification_id" text NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "notification_events_user_id_event_id_pk" PRIMARY KEY("user_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text DEFAULT 'direct' NOT NULL,
	"digest" boolean DEFAULT false NOT NULL,
	"last_digest_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"issue_id" text,
	"project_id" text,
	"kind" text NOT NULL,
	"issue" jsonb NOT NULL,
	"event_count" integer DEFAULT 1 NOT NULL,
	"first_event_at" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"sealed_at" timestamp with time zone,
	"emailed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "requesters" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "visibility" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "requester_id" text;--> statement-breakpoint
ALTER TABLE "helpdesk_requests" ADD CONSTRAINT "helpdesk_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_requests" ADD CONSTRAINT "helpdesk_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_requests" ADD CONSTRAINT "helpdesk_requests_requester_id_requesters_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requesters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_tokens" ADD CONSTRAINT "helpdesk_tokens_issue_id_helpdesk_requests_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."helpdesk_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_watchers" ADD CONSTRAINT "issue_watchers_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_watchers" ADD CONSTRAINT "issue_watchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_event_id_activities_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "help_throttle_ends" ON "help_throttle" USING btree ("window_ends");--> statement-breakpoint
CREATE INDEX "helpdesk_requests_requester" ON "helpdesk_requests" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "helpdesk_requests_project" ON "helpdesk_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "helpdesk_tokens_issue" ON "helpdesk_tokens" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_watchers_user" ON "issue_watchers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mail_outbox_due" ON "mail_outbox" USING btree ("status","send_after");--> statement-breakpoint
CREATE INDEX "notification_events_notification" ON "notification_events" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "notifications_user_last" ON "notifications" USING btree ("user_id","last_event_at");--> statement-breakpoint
CREATE INDEX "notifications_user_issue" ON "notifications" USING btree ("user_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requesters_email_lower" ON "requesters" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_requester_id_requesters_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requesters"("id") ON DELETE set null ON UPDATE no action;
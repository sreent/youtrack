CREATE TABLE "notify_kinds" (
	"user_id" text PRIMARY KEY NOT NULL,
	"watching" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requester_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"requester_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requester_sign_ins" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"requester_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sla_clocks" (
	"issue_id" text NOT NULL,
	"target" text NOT NULL,
	"policy_id" text,
	"target_minutes" integer NOT NULL,
	"used_ms" bigint DEFAULT 0 NOT NULL,
	"running_since" timestamp with time zone,
	"due_at" timestamp with time zone,
	"warn_at" timestamp with time zone,
	"met_at" timestamp with time zone,
	"breached_at" timestamp with time zone,
	"warned_at" timestamp with time zone,
	"breach_told_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sla_clocks_issue_id_target_pk" PRIMARY KEY("issue_id","target")
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"query" text DEFAULT '' NOT NULL,
	"first_response_minutes" integer,
	"resolution_minutes" integer,
	"warn_minutes" integer DEFAULT 60 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_reply_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"public_reply" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "helpdesk_mailboxes" ADD COLUMN "imap_url_sealed" text;--> statement-breakpoint
ALTER TABLE "helpdesk_mailboxes" ADD COLUMN "from_name" text;--> statement-breakpoint
ALTER TABLE "helpdesk_mailboxes" ADD COLUMN "imap_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "helpdesk_mailboxes" ADD COLUMN "imap_error" text;--> statement-breakpoint
ALTER TABLE "helpdesk_requests" ADD COLUMN "waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "kinds" jsonb;--> statement-breakpoint
ALTER TABLE "notify_kinds" ADD CONSTRAINT "notify_kinds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requester_sessions" ADD CONSTRAINT "requester_sessions_requester_id_requesters_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requesters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requester_sign_ins" ADD CONSTRAINT "requester_sign_ins_requester_id_requesters_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requesters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_issue_id_helpdesk_requests_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."helpdesk_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_reply_tokens" ADD CONSTRAINT "team_reply_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_reply_tokens" ADD CONSTRAINT "team_reply_tokens_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requester_sessions_requester" ON "requester_sessions" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "requester_sign_ins_requester" ON "requester_sign_ins" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "sla_clocks_due" ON "sla_clocks" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "sla_clocks_warn" ON "sla_clocks" USING btree ("warn_at");--> statement-breakpoint
CREATE INDEX "sla_policies_project" ON "sla_policies" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "team_reply_tokens_issue" ON "team_reply_tokens" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "team_reply_tokens_created" ON "team_reply_tokens" USING btree ("created_at");
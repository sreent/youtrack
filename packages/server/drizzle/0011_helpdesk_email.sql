CREATE TABLE "helpdesk_imap_state" (
	"mailbox" text PRIMARY KEY NOT NULL,
	"uid_validity" bigint NOT NULL,
	"last_uid" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_inbound" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" text,
	"message_id" text NOT NULL,
	"via" text NOT NULL,
	"sender" text NOT NULL,
	"subject" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"issue_id" text,
	"comment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_mailboxes" (
	"project_id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"secret_hash" text,
	"secret_prefix" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_reply_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "helpdesk_requests" ADD COLUMN "via" text DEFAULT 'form' NOT NULL;--> statement-breakpoint
ALTER TABLE "helpdesk_requests" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "helpdesk_inbound" ADD CONSTRAINT "helpdesk_inbound_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_inbound" ADD CONSTRAINT "helpdesk_inbound_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_mailboxes" ADD CONSTRAINT "helpdesk_mailboxes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_reply_tokens" ADD CONSTRAINT "helpdesk_reply_tokens_issue_id_helpdesk_requests_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."helpdesk_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "helpdesk_inbound_message" ON "helpdesk_inbound" USING btree ("project_id","message_id");--> statement-breakpoint
CREATE INDEX "helpdesk_inbound_project_created" ON "helpdesk_inbound" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "helpdesk_inbound_created" ON "helpdesk_inbound" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "helpdesk_mailboxes_address" ON "helpdesk_mailboxes" USING btree (lower("address"));--> statement-breakpoint
CREATE INDEX "helpdesk_reply_tokens_issue" ON "helpdesk_reply_tokens" USING btree ("issue_id");
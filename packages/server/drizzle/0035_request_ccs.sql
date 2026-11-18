CREATE TABLE "request_ccs" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"via" text NOT NULL,
	"added_by_id" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_via" text,
	"removed_by_id" text
);
--> statement-breakpoint
ALTER TABLE "helpdesk_reply_tokens" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "request_ccs" ADD CONSTRAINT "request_ccs_issue_id_helpdesk_requests_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."helpdesk_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_ccs" ADD CONSTRAINT "request_ccs_added_by_id_users_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_ccs" ADD CONSTRAINT "request_ccs_removed_by_id_users_id_fk" FOREIGN KEY ("removed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "request_ccs_address" ON "request_ccs" USING btree ("issue_id",lower("email"));--> statement-breakpoint
CREATE INDEX "request_ccs_email" ON "request_ccs" USING btree (lower("email"));
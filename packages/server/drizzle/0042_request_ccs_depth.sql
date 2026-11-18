CREATE TABLE "request_cc_confirmations" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_cc_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"held_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_relay_stops" (
	"issue_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_relay_stops_issue_id_requester_id_pk" PRIMARY KEY("issue_id","requester_id")
);
--> statement-breakpoint
ALTER TABLE "request_cc_confirmations" ADD CONSTRAINT "request_cc_confirmations_issue_id_helpdesk_requests_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."helpdesk_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_cc_holds" ADD CONSTRAINT "request_cc_holds_issue_id_helpdesk_requests_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."helpdesk_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_relay_stops" ADD CONSTRAINT "request_relay_stops_issue_id_helpdesk_requests_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."helpdesk_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_relay_stops" ADD CONSTRAINT "request_relay_stops_requester_id_requesters_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requesters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_cc_confirmations_issue" ON "request_cc_confirmations" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_cc_holds_address" ON "request_cc_holds" USING btree ("issue_id",lower("email"));--> statement-breakpoint
CREATE INDEX "request_cc_holds_held" ON "request_cc_holds" USING btree ("held_at");
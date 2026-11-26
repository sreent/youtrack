CREATE TABLE IF NOT EXISTS "group_copy_stops" (
	"group_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"stopped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resumed_at" timestamp with time zone,
	CONSTRAINT "group_copy_stops_group_id_requester_id_pk" PRIMARY KEY("group_id","requester_id")
);
--> statement-breakpoint
ALTER TABLE "group_copy_stops" ADD CONSTRAINT "group_copy_stops_group_id_customer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."customer_groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "group_copy_stops" ADD CONSTRAINT "group_copy_stops_requester_id_requesters_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requesters"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_copy_stops_requester" ON "group_copy_stops" USING btree ("requester_id");
--> statement-breakpoint
ALTER TABLE "request_ccs" ADD COLUMN "group_id" text;
--> statement-breakpoint
ALTER TABLE "request_ccs" ADD CONSTRAINT "request_ccs_group_id_customer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."customer_groups"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requesters_domain" ON "requesters" USING btree (lower(split_part("email", '@', 2)));

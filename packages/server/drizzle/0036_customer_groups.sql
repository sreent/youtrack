CREATE TABLE "customer_group_agents" (
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "customer_group_agents_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "customer_group_domains" (
	"project_id" text NOT NULL,
	"domain" text NOT NULL,
	"group_id" text NOT NULL,
	CONSTRAINT "customer_group_domains_project_id_domain_pk" PRIMARY KEY("project_id","domain")
);
--> statement-breakpoint
CREATE TABLE "customer_group_members" (
	"project_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"group_id" text NOT NULL,
	"added_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_group_members_project_id_requester_id_pk" PRIMARY KEY("project_id","requester_id")
);
--> statement-breakpoint
CREATE TABLE "customer_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"sharing" text DEFAULT 'none' NOT NULL,
	"business_hours" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "helpdesk_requests" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "helpdesk_requests" ADD COLUMN "private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_group_agents" ADD CONSTRAINT "customer_group_agents_group_id_customer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."customer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_group_agents" ADD CONSTRAINT "customer_group_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_group_domains" ADD CONSTRAINT "customer_group_domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_group_domains" ADD CONSTRAINT "customer_group_domains_group_id_customer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."customer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_group_members" ADD CONSTRAINT "customer_group_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_group_members" ADD CONSTRAINT "customer_group_members_requester_id_requesters_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requesters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_group_members" ADD CONSTRAINT "customer_group_members_group_id_customer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."customer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_group_members" ADD CONSTRAINT "customer_group_members_added_by_id_users_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_group_agents_user" ON "customer_group_agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "customer_group_domains_group" ON "customer_group_domains" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "customer_group_members_group" ON "customer_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_groups_project_name" ON "customer_groups" USING btree ("project_id",lower("name"));--> statement-breakpoint
ALTER TABLE "helpdesk_requests" ADD CONSTRAINT "helpdesk_requests_group_id_customer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."customer_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "helpdesk_requests_group" ON "helpdesk_requests" USING btree ("group_id");
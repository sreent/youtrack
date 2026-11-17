CREATE TABLE "board_ranks" (
	"board_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"rank" double precision NOT NULL,
	CONSTRAINT "board_ranks_board_id_issue_id_pk" PRIMARY KEY("board_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "timers" (
	"user_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"running_since" timestamp with time zone,
	"elapsed_seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timers_user_id_issue_id_pk" PRIMARY KEY("user_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "work_types" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "backlog_query" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "points_field_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "work_week" jsonb;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "work_type_id" text;--> statement-breakpoint
ALTER TABLE "board_ranks" ADD CONSTRAINT "board_ranks_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_ranks" ADD CONSTRAINT "board_ranks_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_types" ADD CONSTRAINT "work_types_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_ranks_rank" ON "board_ranks" USING btree ("board_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "timers_one_running" ON "timers" USING btree ("user_id") WHERE "timers"."running_since" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "work_types_project_name" ON "work_types" USING btree ("project_id",lower("name"));--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_points_field_id_fields_id_fk" FOREIGN KEY ("points_field_id") REFERENCES "public"."fields"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_work_type_id_work_types_id_fk" FOREIGN KEY ("work_type_id") REFERENCES "public"."work_types"("id") ON DELETE set null ON UPDATE no action;
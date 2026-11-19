CREATE TABLE "build_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"source_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"repository" text NOT NULL,
	"head_sha" text NOT NULL,
	"name" text NOT NULL,
	"source_name" text NOT NULL,
	"status" text NOT NULL,
	"url" text,
	"check_run_id" text,
	"check_sha" text,
	"written" text,
	"written_at" timestamp with time zone,
	"marks" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"problem" text,
	"problem_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "build_checks_build_id_unique" UNIQUE("build_id")
);
--> statement-breakpoint
ALTER TABLE "build_sources" ADD COLUMN "report_check" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "require_passkeys" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vcs_checks" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "vcs_checks" ADD COLUMN "head_message" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "build_checks" ADD CONSTRAINT "build_checks_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_checks" ADD CONSTRAINT "build_checks_source_id_build_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."build_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_checks" ADD CONSTRAINT "build_checks_integration_id_vcs_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."vcs_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_checks_due" ON "build_checks" USING btree ("due_at");
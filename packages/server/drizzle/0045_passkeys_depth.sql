CREATE TABLE "passkey_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"no" integer,
	"next_update" text,
	"got_at" timestamp with time zone,
	"entries" jsonb,
	"tried_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure" text,
	"failure_detail" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey_setup_links" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"made_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passkeys" ADD COLUMN "attested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "verified_by" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "passkeys_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "passkey_exempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "passkey_setup_links" ADD CONSTRAINT "passkey_setup_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_setup_links" ADD CONSTRAINT "passkey_setup_links_made_by_users_id_fk" FOREIGN KEY ("made_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passkey_setup_links_user" ON "passkey_setup_links" USING btree ("user_id");
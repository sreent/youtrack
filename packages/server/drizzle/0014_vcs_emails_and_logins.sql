CREATE TABLE "email_confirmations" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"login" text NOT NULL,
	"match_key" text NOT NULL,
	"added_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vcs_integrations" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "vcs_integrations" ADD COLUMN "access_token" text;--> statement-breakpoint
ALTER TABLE "email_confirmations" ADD CONSTRAINT "email_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_logins" ADD CONSTRAINT "provider_logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_logins" ADD CONSTRAINT "provider_logins_added_by_id_users_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_emails" ADD CONSTRAINT "user_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_emails" ADD CONSTRAINT "user_emails_confirmed_by_id_users_id_fk" FOREIGN KEY ("confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_confirmations_user" ON "email_confirmations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_confirmations_expires" ON "email_confirmations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_logins_once" ON "provider_logins" USING btree ("provider","match_key");--> statement-breakpoint
CREATE INDEX "provider_logins_user" ON "provider_logins" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_emails_once" ON "user_emails" USING btree ("user_id",lower("email"));--> statement-breakpoint
CREATE INDEX "user_emails_address" ON "user_emails" USING btree (lower("email"));
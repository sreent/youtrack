CREATE TABLE "passkey_alerts" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"change" text NOT NULL,
	"passkey_id" text,
	"name" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"user_id" text,
	"bound_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"multi_device" boolean DEFAULT false NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"aaguid" text,
	"name" text NOT NULL,
	"rp_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"copied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "signed_in_with" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "passkey_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "verified_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "passkey_alerts" ADD CONSTRAINT "passkey_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_challenges" ADD CONSTRAINT "passkey_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passkey_alerts_user" ON "passkey_alerts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_challenges_expires" ON "passkey_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "passkeys_credential" ON "passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "passkeys_user" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_passkey" ON "sessions" USING btree ("passkey_id");
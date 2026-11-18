CREATE TABLE "requester_passkey_alerts" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"requester_id" text NOT NULL,
	"change" text NOT NULL,
	"passkey_id" text,
	"name" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requester_passkey_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"requester_id" text,
	"bound_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requester_passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"requester_id" text NOT NULL,
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
ALTER TABLE "requester_sessions" ADD COLUMN "passkey_id" text;--> statement-breakpoint
ALTER TABLE "requester_sessions" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requester_passkey_alerts" ADD CONSTRAINT "requester_passkey_alerts_requester_id_requesters_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requesters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requester_passkey_challenges" ADD CONSTRAINT "requester_passkey_challenges_requester_id_requesters_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requesters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requester_passkeys" ADD CONSTRAINT "requester_passkeys_requester_id_requesters_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requesters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requester_passkey_alerts_requester" ON "requester_passkey_alerts" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "requester_passkey_challenges_expires" ON "requester_passkey_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "requester_passkeys_credential" ON "requester_passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "requester_passkeys_requester" ON "requester_passkeys" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "requester_sessions_passkey" ON "requester_sessions" USING btree ("passkey_id");
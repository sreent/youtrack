CREATE TABLE "portal_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_sealed" text,
	"scopes" text DEFAULT 'openid email profile' NOT NULL,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_sso_states" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"desk" text,
	"code_verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requester_identities" (
	"requester_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requester_identities_requester_id_provider_id_pk" PRIMARY KEY("requester_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "customer_groups" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "requester_sessions" ADD COLUMN "method" text DEFAULT 'link' NOT NULL;--> statement-breakpoint
ALTER TABLE "requester_sessions" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "requester_sign_ins" ADD COLUMN "purpose" text DEFAULT 'sign-in' NOT NULL;--> statement-breakpoint
ALTER TABLE "requesters" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "requesters" ADD COLUMN "password_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portal_sso_states" ADD CONSTRAINT "portal_sso_states_provider_id_portal_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."portal_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requester_identities" ADD CONSTRAINT "requester_identities_requester_id_requesters_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requesters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requester_identities" ADD CONSTRAINT "requester_identities_provider_id_portal_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."portal_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_provider_id_portal_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."portal_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requester_sessions" ADD CONSTRAINT "requester_sessions_provider_id_portal_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."portal_providers"("id") ON DELETE cascade ON UPDATE no action;
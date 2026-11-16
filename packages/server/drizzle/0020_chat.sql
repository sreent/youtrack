CREATE TABLE "chat_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"external_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gone_at" timestamp with time zone,
	"gone_reason" text
);
--> statement-breakpoint
CREATE TABLE "chat_link_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"external_user_id" text NOT NULL,
	"name" text NOT NULL,
	"reply" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"channel_id" text NOT NULL,
	"subscription_id" text,
	"event_id" bigint,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"message_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "chat_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"project_id" text,
	"saved_search_id" text,
	"kinds" text[] NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text
);
--> statement-breakpoint
CREATE TABLE "chat_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"tenant_id" text,
	"name" text NOT NULL,
	"service_url" text,
	"bot_token" text,
	"signing_secret" text,
	"bot_user_id" text,
	"connected_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_reason" text
);
--> statement-breakpoint
ALTER TABLE "user_identities" ADD COLUMN "object_id" text;--> statement-breakpoint
ALTER TABLE "user_identities" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "chat_accounts" ADD CONSTRAINT "chat_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_workspace_id_chat_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."chat_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_outbox" ADD CONSTRAINT "chat_outbox_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_outbox" ADD CONSTRAINT "chat_outbox_subscription_id_chat_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."chat_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_subscriptions" ADD CONSTRAINT "chat_subscriptions_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_subscriptions" ADD CONSTRAINT "chat_subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_subscriptions" ADD CONSTRAINT "chat_subscriptions_saved_search_id_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."saved_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_subscriptions" ADD CONSTRAINT "chat_subscriptions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_workspaces" ADD CONSTRAINT "chat_workspaces_connected_by_id_users_id_fk" FOREIGN KEY ("connected_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_accounts_external" ON "chat_accounts" USING btree ("platform","workspace_external_id","external_user_id");--> statement-breakpoint
CREATE INDEX "chat_accounts_user" ON "chat_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_channels_external" ON "chat_channels" USING btree ("workspace_id","external_id");--> statement-breakpoint
CREATE INDEX "chat_link_tokens_expires" ON "chat_link_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "chat_outbox_due" ON "chat_outbox" USING btree ("status","send_after");--> statement-breakpoint
CREATE INDEX "chat_subscriptions_channel" ON "chat_subscriptions" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "chat_subscriptions_project" ON "chat_subscriptions" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_workspaces_external" ON "chat_workspaces" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "user_identities_object" ON "user_identities" USING btree ("tenant_id","object_id");
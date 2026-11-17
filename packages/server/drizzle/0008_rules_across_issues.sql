ALTER TABLE "rules" ADD COLUMN "related" jsonb;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "target" jsonb;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "notify" jsonb;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "call_webhook_id" text;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_call_webhook_id_webhooks_id_fk" FOREIGN KEY ("call_webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE restrict ON UPDATE no action;
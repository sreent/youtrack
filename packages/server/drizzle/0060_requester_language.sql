ALTER TABLE "requesters" ADD COLUMN "chosen_locale" text;
--> statement-breakpoint
ALTER TABLE "portal_sso_states" ADD COLUMN "locale" text;

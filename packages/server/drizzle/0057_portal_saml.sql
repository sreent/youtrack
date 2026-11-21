ALTER TABLE "portal_providers" ADD COLUMN "kind" text DEFAULT 'oidc' NOT NULL;
--> statement-breakpoint
ALTER TABLE "portal_providers" ADD COLUMN "saml_entry_point" text;
--> statement-breakpoint
ALTER TABLE "portal_providers" ADD COLUMN "saml_cert" text;
--> statement-breakpoint
ALTER TABLE "portal_providers" ADD COLUMN "saml_entity_id" text;

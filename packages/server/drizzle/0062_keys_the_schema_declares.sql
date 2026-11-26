-- Six foreign keys schema.ts has declared since their tables came, which the hand-written migrations
-- 0049, 0051, 0055 and 0058 never made. Before each, the rows that would break it go as the key
-- itself would have taken them: a cascade's are deleted, a set null's are cleared.
DELETE FROM "attachments" a WHERE a."whiteboard_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "whiteboards" w WHERE w."id" = a."whiteboard_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_whiteboard_id_whiteboards_id_fk" FOREIGN KEY ("whiteboard_id") REFERENCES "public"."whiteboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DELETE FROM "chat_posts" p WHERE NOT EXISTS (SELECT 1 FROM "chat_channels" c WHERE c."id" = p."channel_id");--> statement-breakpoint
ALTER TABLE "chat_posts" ADD CONSTRAINT "chat_posts_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A desk's own provider outlives no desk; one a customer group still names (which a desk can't do
-- with another desk's) stays, and the key, made NOT VALID, is checked for what's left rather than
-- stopping the server from starting: it holds for every row from now on either way.
DELETE FROM "portal_providers" p WHERE p."project_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "projects" x WHERE x."id" = p."project_id") AND NOT EXISTS (SELECT 1 FROM "customer_groups" g WHERE g."provider_id" = p."id");--> statement-breakpoint
ALTER TABLE "portal_providers" ADD CONSTRAINT "portal_providers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "portal_providers" VALIDATE CONSTRAINT "portal_providers_project_id_projects_id_fk";
EXCEPTION WHEN foreign_key_violation THEN
  RAISE WARNING 'portal_providers_project_id_projects_id_fk: a provider of a deleted desk is still named by a customer group; the key holds for new rows only until that group changes';
END $$;--> statement-breakpoint
DELETE FROM "timesheet_weeks" t WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = t."user_id");--> statement-breakpoint
ALTER TABLE "timesheet_weeks" ADD CONSTRAINT "timesheet_weeks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "timesheet_weeks" t SET "approved_by_id" = NULL WHERE t."approved_by_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = t."approved_by_id");--> statement-breakpoint
ALTER TABLE "timesheet_weeks" ADD CONSTRAINT "timesheet_weeks_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- After the attachments above: an element whose picture went with its whiteboard's loses the link.
UPDATE "whiteboard_elements" e SET "attachment_id" = NULL WHERE e."attachment_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "attachments" a WHERE a."id" = e."attachment_id");--> statement-breakpoint
ALTER TABLE "whiteboard_elements" ADD CONSTRAINT "whiteboard_elements_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;

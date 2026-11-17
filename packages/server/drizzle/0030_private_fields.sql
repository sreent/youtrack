ALTER TABLE "fields" ADD COLUMN "former_names" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "project_fields" ADD COLUMN "private" boolean DEFAULT false NOT NULL;
CREATE TABLE "login_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"failures" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "login_throttle_window" ON "login_throttle" USING btree ("window_start");
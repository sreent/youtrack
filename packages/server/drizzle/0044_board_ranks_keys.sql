CREATE TABLE "board_lane_ranks" (
	"board_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"lane" text NOT NULL,
	"key" text COLLATE "C" NOT NULL,
	CONSTRAINT "board_lane_ranks_board_id_issue_id_pk" PRIMARY KEY("board_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "board_moves" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"board_id" text,
	"actor_id" text,
	"channel" text NOT NULL,
	"token_name" text,
	"anchor_id" text,
	"side" text NOT NULL,
	"moves" integer DEFAULT 1 NOT NULL,
	"last_event_id" bigint NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text NOT NULL,
	"said" jsonb NOT NULL
);
--> statement-breakpoint
DROP INDEX "board_ranks_rank";--> statement-breakpoint
-- D65: every board's ranks, doubles until now, become keys in the order they were in (ties by
-- issue, as a move read them): the nth of a board is the shared keyAt(n), "a0", "a1" ... "az", "b00" ...
-- Written by hand around what drizzle-kit generates: a column added NOT NULL to a table with rows
-- would fail, and the doubles must be read before they're dropped. Keep these four statements when
-- the migrations are generated again.
ALTER TABLE "board_ranks" ADD COLUMN "key" text COLLATE "C";--> statement-breakpoint
UPDATE "board_ranks" AS br SET "key" = CASE
    WHEN r.n < 62 THEN 'a' || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 0) / 1 % 62)::int + 1, 1)
    WHEN r.n < 3906 THEN 'b' || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 62) / 62 % 62)::int + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 62) / 1 % 62)::int + 1, 1)
    WHEN r.n < 242234 THEN 'c' || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 3906) / 3844 % 62)::int + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 3906) / 62 % 62)::int + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 3906) / 1 % 62)::int + 1, 1)
    WHEN r.n < 15018570 THEN 'd' || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 242234) / 238328 % 62)::int + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 242234) / 3844 % 62)::int + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 242234) / 62 % 62)::int + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 242234) / 1 % 62)::int + 1, 1)
    ELSE 'e' || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 15018570) / 14776336 % 62)::int + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 15018570) / 238328 % 62)::int + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 15018570) / 3844 % 62)::int + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 15018570) / 62 % 62)::int + 1, 1) || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((r.n - 15018570) / 1 % 62)::int + 1, 1)
  END
FROM (SELECT board_id, issue_id, row_number() OVER (PARTITION BY board_id ORDER BY rank, issue_id) - 1 AS n FROM "board_ranks") AS r
WHERE br.board_id = r.board_id AND br.issue_id = r.issue_id;--> statement-breakpoint
ALTER TABLE "board_ranks" ALTER COLUMN "key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "lane_order" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "board_lane_ranks" ADD CONSTRAINT "board_lane_ranks_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_lane_ranks" ADD CONSTRAINT "board_lane_ranks_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_moves" ADD CONSTRAINT "board_moves_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_moves" ADD CONSTRAINT "board_moves_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_moves" ADD CONSTRAINT "board_moves_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_moves" ADD CONSTRAINT "board_moves_anchor_id_issues_id_fk" FOREIGN KEY ("anchor_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_lane_ranks_key" ON "board_lane_ranks" USING btree ("board_id","lane","key");--> statement-breakpoint
CREATE INDEX "board_moves_issue" ON "board_moves" USING btree ("issue_id","last_event_id");--> statement-breakpoint
CREATE INDEX "board_ranks_key" ON "board_ranks" USING btree ("board_id","key");--> statement-breakpoint
ALTER TABLE "board_ranks" DROP COLUMN "rank";
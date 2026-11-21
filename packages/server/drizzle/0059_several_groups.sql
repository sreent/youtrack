ALTER TABLE "customer_group_members" DROP CONSTRAINT "customer_group_members_project_id_requester_id_pk";
--> statement-breakpoint
ALTER TABLE "customer_group_members" ADD PRIMARY KEY ("project_id","requester_id","group_id");

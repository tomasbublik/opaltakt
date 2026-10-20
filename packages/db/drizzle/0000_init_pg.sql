CREATE TABLE "backlog_dismissal" (
	"wp_op_id" integer PRIMARY KEY NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "burndown_snapshot" (
	"id" serial PRIMARY KEY NOT NULL,
	"sprint_id" integer NOT NULL,
	"snapshot_date" date NOT NULL,
	"remaining_hours" double precision NOT NULL,
	"logged_hours" double precision NOT NULL,
	"ideal_hours" double precision NOT NULL,
	"done_count" integer NOT NULL,
	"total_count" integer NOT NULL,
	"source" text DEFAULT 'live' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capacity_edit_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"sprint_id" integer NOT NULL,
	"edited_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"changes_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "done_rule" (
	"id" serial PRIMARY KEY NOT NULL,
	"status_name" text NOT NULL,
	"kind" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "done_status_rule" (
	"id" serial PRIMARY KEY NOT NULL,
	"sprint_id" integer NOT NULL,
	"status_name" text NOT NULL,
	"counts_as" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_override" (
	"id" serial PRIMARY KEY NOT NULL,
	"wp_op_id" integer NOT NULL,
	"planning_hours" double precision NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_selection" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" integer,
	"project_op_id" integer NOT NULL,
	"project_name" text NOT NULL,
	"version_op_id" integer,
	"version_name" text,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "op_connection" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"label" text,
	"token_encrypted" text,
	"token_ct" text,
	"token_nonce" text,
	"token_tag" text,
	"default_project_op_id" integer,
	"is_current" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"last_activity_at" timestamp with time zone,
	"last_check_at" timestamp with time zone,
	"last_status" text DEFAULT 'unknown' NOT NULL,
	"last_latency_ms" double precision,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" integer,
	"op_id" integer NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "remaining_status_rule" (
	"id" serial PRIMARY KEY NOT NULL,
	"sprint_id" integer NOT NULL,
	"status_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_config" (
	"id" integer PRIMARY KEY NOT NULL,
	"overshoot_threshold_pct" double precision DEFAULT 25 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprint" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'planning' NOT NULL,
	"capacity_mode" text DEFAULT 'per_person' NOT NULL,
	"completed_hours" double precision,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"closed_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"is_locked" boolean DEFAULT false NOT NULL,
	"lock_reason" text,
	"baseline_total_hours" double precision,
	"is_retrospective" boolean DEFAULT false NOT NULL,
	"retro_seed_kind" text,
	"retro_seed_value" text,
	"retro_replayed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sprint_closure_report" (
	"id" serial PRIMARY KEY NOT NULL,
	"sprint_id" integer NOT NULL,
	"generated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"done_json" jsonb NOT NULL,
	"not_done_json" jsonb NOT NULL,
	"version_change_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprint_item" (
	"id" serial PRIMARY KEY NOT NULL,
	"sprint_id" integer NOT NULL,
	"wp_op_id" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"planned_hours" double precision,
	"outcome" text DEFAULT 'planned' NOT NULL,
	"removed_at" timestamp with time zone,
	"origin" text DEFAULT 'baseline' NOT NULL,
	"retro_source" text
);
--> statement-breakpoint
CREATE TABLE "sprint_member_capacity" (
	"id" serial PRIMARY KEY NOT NULL,
	"sprint_id" integer NOT NULL,
	"member_id" integer NOT NULL,
	"available_hours" double precision NOT NULL,
	"pto_days" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprint_update_run" (
	"id" serial PRIMARY KEY NOT NULL,
	"sprint_id" integer NOT NULL,
	"kind" text NOT NULL,
	"triggered_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"finished_at" timestamp with time zone,
	"wp_count" integer,
	"total_count" integer,
	"changes_count" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "sync_run" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"finished_at" timestamp with time zone,
	"kind" text NOT NULL,
	"wp_count" integer,
	"total_count" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"last_progress_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "team_member" (
	"id" serial PRIMARY KEY NOT NULL,
	"op_user_id" integer,
	"name" text NOT NULL,
	"default_hours_per_day" double precision NOT NULL,
	"role" text DEFAULT 'unset' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_baseline" (
	"id" serial PRIMARY KEY NOT NULL,
	"sprint_id" integer NOT NULL,
	"wp_op_id" integer NOT NULL,
	"captured_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"subject" text NOT NULL,
	"status_name" text NOT NULL,
	"status_is_closed" boolean NOT NULL,
	"assignee_op_id" integer,
	"accountable_op_id" integer,
	"original_assignee_op_id" integer,
	"estimated_hours" double precision,
	"remaining_hours" double precision,
	"spent_hours" double precision,
	"version_op_id" integer,
	"raw_json" jsonb NOT NULL,
	"origin" text DEFAULT 'baseline' NOT NULL,
	"reconstructed" boolean DEFAULT false NOT NULL,
	"reconstruction_gaps_json" jsonb,
	"assignee_name_raw" text
);
--> statement-breakpoint
CREATE TABLE "ticket_changelog_entry" (
	"id" serial PRIMARY KEY NOT NULL,
	"sprint_id" integer NOT NULL,
	"wp_op_id" integer NOT NULL,
	"update_run_id" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_op_id" integer,
	"actor_name" text,
	"kind" text NOT NULL,
	"detail_json" jsonb NOT NULL,
	"source" text NOT NULL,
	"op_journal_id" integer,
	"dedup_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_name_alias" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" integer NOT NULL,
	"journal_name" text NOT NULL,
	"op_user_id" integer,
	"merge_into_name" text,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_meta" (
	"id" integer PRIMARY KEY NOT NULL,
	"kdf_algo" text NOT NULL,
	"kdf_salt" text NOT NULL,
	"kdf_params_json" jsonb NOT NULL,
	"verifier_ct" text NOT NULL,
	"verifier_nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_package_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" integer,
	"op_id" integer NOT NULL,
	"project_op_id" integer NOT NULL,
	"subject" text NOT NULL,
	"type_name" text NOT NULL,
	"status_name" text NOT NULL,
	"status_is_closed" boolean NOT NULL,
	"assignee_op_id" integer,
	"assignee_name" text,
	"estimated_hours" double precision,
	"remaining_hours" double precision,
	"spent_hours" double precision,
	"story_points" double precision,
	"version_op_id" integer,
	"version_name" text,
	"priority" text,
	"parent_op_id" integer,
	"percentage_done" double precision,
	"updated_at_op" timestamp with time zone NOT NULL,
	"raw_json" jsonb NOT NULL,
	"cached_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_package_cache_staging" (
	"id" serial PRIMARY KEY NOT NULL,
	"sync_run_id" integer NOT NULL,
	"connection_id" integer,
	"op_id" integer NOT NULL,
	"project_op_id" integer NOT NULL,
	"subject" text NOT NULL,
	"type_name" text NOT NULL,
	"status_name" text NOT NULL,
	"status_is_closed" boolean NOT NULL,
	"assignee_op_id" integer,
	"assignee_name" text,
	"estimated_hours" double precision,
	"remaining_hours" double precision,
	"spent_hours" double precision,
	"story_points" double precision,
	"version_op_id" integer,
	"version_name" text,
	"priority" text,
	"parent_op_id" integer,
	"percentage_done" double precision,
	"updated_at_op" timestamp with time zone NOT NULL,
	"raw_json" jsonb NOT NULL,
	"cached_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "burndown_snapshot" ADD CONSTRAINT "burndown_snapshot_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_edit_audit" ADD CONSTRAINT "capacity_edit_audit_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "done_status_rule" ADD CONSTRAINT "done_status_rule_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_selection" ADD CONSTRAINT "import_selection_connection_id_op_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."op_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_connection_id_op_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."op_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remaining_status_rule" ADD CONSTRAINT "remaining_status_rule_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_closure_report" ADD CONSTRAINT "sprint_closure_report_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_item" ADD CONSTRAINT "sprint_item_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_member_capacity" ADD CONSTRAINT "sprint_member_capacity_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_member_capacity" ADD CONSTRAINT "sprint_member_capacity_member_id_team_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."team_member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_update_run" ADD CONSTRAINT "sprint_update_run_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_baseline" ADD CONSTRAINT "ticket_baseline_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_changelog_entry" ADD CONSTRAINT "ticket_changelog_entry_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_changelog_entry" ADD CONSTRAINT "ticket_changelog_entry_update_run_id_sprint_update_run_id_fk" FOREIGN KEY ("update_run_id") REFERENCES "public"."sprint_update_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_name_alias" ADD CONSTRAINT "user_name_alias_connection_id_op_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."op_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_package_cache" ADD CONSTRAINT "work_package_cache_connection_id_op_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."op_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_package_cache_staging" ADD CONSTRAINT "work_package_cache_staging_sync_run_id_sync_run_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_package_cache_staging" ADD CONSTRAINT "work_package_cache_staging_connection_id_op_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."op_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "burndown_sprint_date_uq" ON "burndown_snapshot" USING btree ("sprint_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "burndown_snapshot_sprint_idx" ON "burndown_snapshot" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "capacity_edit_audit_sprint_idx" ON "capacity_edit_audit" USING btree ("sprint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "done_rule_status_uq" ON "done_rule" USING btree ("status_name");--> statement-breakpoint
CREATE INDEX "done_status_rule_sprint_idx" ON "done_status_rule" USING btree ("sprint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "estimate_override_wp_uq" ON "estimate_override" USING btree ("wp_op_id");--> statement-breakpoint
CREATE INDEX "import_selection_connection_idx" ON "import_selection" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "op_connection_base_url_uq" ON "op_connection" USING btree ("base_url");--> statement-breakpoint
CREATE UNIQUE INDEX "project_connection_op_id_uq" ON "project" USING btree ("connection_id","op_id");--> statement-breakpoint
CREATE INDEX "remaining_status_rule_sprint_idx" ON "remaining_status_rule" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "sprint_item_sprint_idx" ON "sprint_item" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "sprint_item_wp_idx" ON "sprint_item" USING btree ("wp_op_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sprint_item_sprint_wp_uq" ON "sprint_item" USING btree ("sprint_id","wp_op_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sprint_member_uq" ON "sprint_member_capacity" USING btree ("sprint_id","member_id");--> statement-breakpoint
CREATE INDEX "sprint_member_capacity_sprint_idx" ON "sprint_member_capacity" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "sprint_update_run_sprint_idx" ON "sprint_update_run" USING btree ("sprint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_baseline_sprint_wp_uq" ON "ticket_baseline" USING btree ("sprint_id","wp_op_id");--> statement-breakpoint
CREATE INDEX "ticket_baseline_sprint_idx" ON "ticket_baseline" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "ticket_baseline_wp_idx" ON "ticket_baseline" USING btree ("wp_op_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_changelog_dedup_uq" ON "ticket_changelog_entry" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "ticket_changelog_ticket_idx" ON "ticket_changelog_entry" USING btree ("sprint_id","wp_op_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_name_alias_conn_name_uq" ON "user_name_alias" USING btree ("connection_id","journal_name");--> statement-breakpoint
CREATE UNIQUE INDEX "wp_cache_op_id_uq" ON "work_package_cache" USING btree ("op_id");--> statement-breakpoint
CREATE INDEX "wp_cache_project_idx" ON "work_package_cache" USING btree ("project_op_id");--> statement-breakpoint
CREATE INDEX "wp_cache_assignee_idx" ON "work_package_cache" USING btree ("assignee_op_id");--> statement-breakpoint
CREATE INDEX "wp_cache_connection_idx" ON "work_package_cache" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "wp_cache_staging_run_idx" ON "work_package_cache_staging" USING btree ("sync_run_id");
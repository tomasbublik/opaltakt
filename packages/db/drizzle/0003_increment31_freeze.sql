-- Increment 31 (docs/INCREMENT_31_CONTRACTS.md §1) — sprint freeze snapshot.
--
-- HAND-EDITED to be IDEMPOTENT (IF NOT EXISTS on every column): during the
-- increment the user's long-lived `tsx watch` dev session restarted on a file
-- change and applied an INTERMEDIATE draft of this migration (7 of the 8
-- sprint_item columns — everything except frozen_project_op_id, a Phase-2
-- contract amendment) to the real database; the file was then regenerated
-- under a new journal timestamp, so the migrator legitimately re-runs it.
-- Plain ADD COLUMN therefore crashed boot with 42701 on that database, while
-- a fresh database needs every line. IF NOT EXISTS heals BOTH states — and is
-- the standing convention for any migration a watching dev server might race
-- (see memory: osp-local-db-permission).
ALTER TABLE "report_config" ADD COLUMN IF NOT EXISTS "freeze_grace_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "sprint" ADD COLUMN IF NOT EXISTS "frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sprint_item" ADD COLUMN IF NOT EXISTS "frozen_effective_hours" double precision;--> statement-breakpoint
ALTER TABLE "sprint_item" ADD COLUMN IF NOT EXISTS "frozen_assignee_op_id" integer;--> statement-breakpoint
ALTER TABLE "sprint_item" ADD COLUMN IF NOT EXISTS "frozen_assignee_name" text;--> statement-breakpoint
ALTER TABLE "sprint_item" ADD COLUMN IF NOT EXISTS "frozen_status_name" text;--> statement-breakpoint
ALTER TABLE "sprint_item" ADD COLUMN IF NOT EXISTS "frozen_status_is_closed" boolean;--> statement-breakpoint
ALTER TABLE "sprint_item" ADD COLUMN IF NOT EXISTS "frozen_parent_op_id" integer;--> statement-breakpoint
ALTER TABLE "sprint_item" ADD COLUMN IF NOT EXISTS "frozen_connection_id" integer;--> statement-breakpoint
ALTER TABLE "sprint_item" ADD COLUMN IF NOT EXISTS "frozen_project_op_id" integer;

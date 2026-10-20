-- Increment 32 (docs/INCREMENT_32_CONTRACTS.md §2) — off-sprint time report.
--
-- HAND-EDITED to be IDEMPOTENT (IF NOT EXISTS on the table/indexes, a
-- duplicate_object-tolerant DO block on the FK constraints), per the
-- migration convention learned during Increment 31 (see that migration's own
-- header comment): the user's long-lived `tsx watch` dev session applies
-- migrations to the real database on every restart, so a plain CREATE TABLE
-- would crash boot with 42P07 if this file ever re-runs against a database
-- that already has (a draft of) it.
CREATE TABLE IF NOT EXISTS "off_sprint_time_entry" (
	"id" serial PRIMARY KEY NOT NULL,
	"sprint_id" integer NOT NULL,
	"connection_id" integer,
	"op_time_entry_id" integer NOT NULL,
	"wp_op_id" integer NOT NULL,
	"wp_subject" text,
	"actor_op_id" integer NOT NULL,
	"actor_name" text,
	"spent_on" date NOT NULL,
	"hours" double precision NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "off_sprint_time_entry" ADD CONSTRAINT "off_sprint_time_entry_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "off_sprint_time_entry" ADD CONSTRAINT "off_sprint_time_entry_connection_id_op_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."op_connection"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "off_sprint_time_entry_sprint_op_te_uq" ON "off_sprint_time_entry" USING btree ("sprint_id","op_time_entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "off_sprint_time_entry_sprint_idx" ON "off_sprint_time_entry" USING btree ("sprint_id");

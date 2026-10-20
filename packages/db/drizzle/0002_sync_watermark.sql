CREATE TABLE "sync_watermark" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" integer,
	"project_op_id" integer NOT NULL,
	"watermark_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_watermark" ADD CONSTRAINT "sync_watermark_connection_id_op_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."op_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_watermark_connection_project_uq" ON "sync_watermark" USING btree ("connection_id","project_op_id");
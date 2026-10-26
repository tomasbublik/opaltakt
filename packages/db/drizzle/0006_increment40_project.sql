-- Increment 40 (docs/INCREMENT_40_CONTRACTS.md §2.A1) — the OpenProject
-- project of every ticket.
--
--  * work_package_cache(.staging).project_name — raw `_links.project.title`
--    at the last fetch (display-only; project_op_id stays the identity).
--  * sprint_item.frozen_project_name / frozen_project_identifier — the
--    project's display values AT FREEZE TIME (Increment 31 freeze snapshot,
--    CAPACITY_BAR_RULES §6 invariant 10 extended).
--
-- IDEMPOTENT per the standing convention (0003/0005 headers): every ADD
-- COLUMN is IF NOT EXISTS, and every backfill only fills NULLs, so re-running
-- this file against a database that already has it changes nothing.
--
-- The backfill is pure SQL — zero OpenProject calls.
ALTER TABLE "work_package_cache" ADD COLUMN IF NOT EXISTS "project_name" text;--> statement-breakpoint
ALTER TABLE "work_package_cache_staging" ADD COLUMN IF NOT EXISTS "project_name" text;--> statement-breakpoint
ALTER TABLE "sprint_item" ADD COLUMN IF NOT EXISTS "frozen_project_name" text;--> statement-breakpoint
ALTER TABLE "sprint_item" ADD COLUMN IF NOT EXISTS "frozen_project_identifier" text;--> statement-breakpoint
-- Backfill 1: the cache's project name from the stored WP payload.
UPDATE "work_package_cache"
   SET "project_name" = NULLIF("raw_json" #>> '{_links,project,title}', '')
 WHERE "project_name" IS NULL
   AND NULLIF("raw_json" #>> '{_links,project,title}', '') IS NOT NULL;--> statement-breakpoint
-- Backfill 2: frozen sprints' project snapshot (non-removed items whose
-- frozen_project_name is still NULL). Never touches non-frozen sprints.
--   op_id      : existing frozen_project_op_id, else the cache row's
--                project_op_id (0 → unknown), else the ticket_baseline
--                payload's `_links.project.href` trailing integer.
--   name       : cache project_name, else the baseline payload's title —
--                each ONLY when its project op_id equals the resolved one (a
--                ticket moved to another project after the freeze must not
--                lend the new project's name to the frozen snapshot).
--   identifier : project.identifier keyed (frozen_connection_id, op_id);
--                with a NULL frozen_connection_id only when exactly ONE
--                project row has that op_id (pillar 2: op_id is unique only
--                within a server) — otherwise left NULL.
-- Anything unresolvable stays NULL (renders "—").
WITH "target" AS (
  SELECT si."id",
         si."sprint_id",
         si."wp_op_id",
         si."frozen_connection_id",
         COALESCE(
           si."frozen_project_op_id",
           (SELECT NULLIF(w."project_op_id", 0)
              FROM "work_package_cache" w
             WHERE w."op_id" = si."wp_op_id"),
           (SELECT NULLIF(substring(tb."raw_json" #>> '{_links,project,href}' FROM '(\d+)/?$'), '')::integer
              FROM "ticket_baseline" tb
             WHERE tb."sprint_id" = si."sprint_id"
               AND tb."wp_op_id" = si."wp_op_id")
         ) AS "pid"
    FROM "sprint_item" si
    JOIN "sprint" s ON s."id" = si."sprint_id"
   WHERE s."frozen_at" IS NOT NULL
     AND si."outcome" NOT IN ('removed', 'removed_mid_sprint')
     AND si."frozen_project_name" IS NULL
),
"resolved" AS (
  SELECT t."id",
         t."pid",
         COALESCE(
           (SELECT NULLIF(w."project_name", '')
              FROM "work_package_cache" w
             WHERE w."op_id" = t."wp_op_id"
               AND w."project_op_id" = t."pid"),
           (SELECT NULLIF(tb."raw_json" #>> '{_links,project,title}', '')
              FROM "ticket_baseline" tb
             WHERE tb."sprint_id" = t."sprint_id"
               AND tb."wp_op_id" = t."wp_op_id"
               AND substring(tb."raw_json" #>> '{_links,project,href}' FROM '(\d+)/?$') = t."pid"::text)
         ) AS "pname",
         CASE
           WHEN t."frozen_connection_id" IS NOT NULL THEN
             (SELECT p."identifier"
                FROM "project" p
               WHERE p."connection_id" = t."frozen_connection_id"
                 AND p."op_id" = t."pid")
           ELSE
             (SELECT min(p."identifier")
                FROM "project" p
               WHERE p."op_id" = t."pid"
              HAVING count(*) = 1)
         END AS "pident"
    FROM "target" t
   WHERE t."pid" IS NOT NULL
)
UPDATE "sprint_item" si
   SET "frozen_project_op_id" = COALESCE(si."frozen_project_op_id", r."pid"),
       "frozen_project_name" = r."pname",
       "frozen_project_identifier" = COALESCE(si."frozen_project_identifier", r."pident")
  FROM "resolved" r
 WHERE si."id" = r."id";

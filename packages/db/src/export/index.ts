/**
 * @osp/db/export — engine-agnostic, versioned JSON export & import
 * (Increment 27, CONTRACTS §6).
 *
 * One implementation serves three callers:
 *   - `apps/api/src/routes/data.ts`            (GET /api/data/export, POST /api/data/import)
 *   - `scripts/migrate-sqlite-to-pg.ts`        (the one-off SQLite → Postgres cut)
 *   - any future "stand up a server with my data" flow
 *
 * so there is exactly one definition of what travels, in what order, and with
 * which secrets — see `tables.ts`.
 */
export * from "./types";
export * from "./tables";
export * from "./exportAll";
export * from "./importAll";

/**
 * @osp/db — Drizzle PostgreSQL schema + repository interfaces.
 *
 * Increment 27: the store is PostgreSQL (real `pg` for the app/e2e, in-process
 * PGlite for unit tests). `openDb()` is async — see factory.ts for the API.
 * Migrations live in ./drizzle (generated via `pnpm db:generate`).
 */
export * from "./columnTypes";
export * from "./schema";
export * from "./repositories";
export * from "./mappers";
export * from "./repos";
export * from "./factory";
export * from "./export/index";

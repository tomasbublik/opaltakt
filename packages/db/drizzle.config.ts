import { defineConfig } from "drizzle-kit";

/**
 * Drizzle-kit config. Generates migrations from src/schema.ts.
 *
 * Increment 27: the store is PostgreSQL (CONTRACTS §1). The target database is
 * taken from `DATABASE_URL` with NO fallback — the same guardrail as the app
 * itself (apps/api/src/server.ts). Never point this at the real `osp` database
 * from an agent or test run; use a throwaway `osp_test_*` / `osp_e2e_*` DB.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});

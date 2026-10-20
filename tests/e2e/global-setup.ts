import { writeForbiddenActivitySnapshot } from "./global-db";

/**
 * Playwright globalSetup.
 *
 * ⚠️ This does NOT create the throwaway database — Playwright starts every
 * `webServer` BEFORE globalSetup, so creation happens in the API's own command
 * (see `createE2eDatabaseCommand`). What runs here is the isolation baseline:
 * the write counters of the databases that must never be touched, captured
 * before any spec executes. tz-db-isolation.spec.ts compares against it at the
 * end of the run.
 */
export default async function globalSetup(): Promise<void> {
  // The Postgres-era successor to the "real osp.sqlite is byte-identical"
  // tripwire: baseline the write counters of `osp`, OSP_FOREIGN_DATABASES, … before any
  // spec runs.
  await writeForbiddenActivitySnapshot();
}

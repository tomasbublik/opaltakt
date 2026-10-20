import { dropE2eDatabase } from "./global-db";

/**
 * Playwright globalTeardown — drop the run's throwaway database.
 *
 * Runs after every webServer has been torn down, so no connection is holding
 * it open (`DROP DATABASE … WITH (FORCE)` covers a straggler anyway). Never
 * throws: a failed drop leaves a harmless `osp_e2e_<pid>` behind, and masking
 * a genuine test failure with a teardown error would be far worse.
 */
export default async function globalTeardown(): Promise<void> {
  await dropE2eDatabase();
}

import { fileURLToPath } from "node:url";
import { startMockOpServer } from "./mock-op-server/index";

/**
 * Package entry ("@osp/fixtures") — thin boot shim over the stateful mock in
 * ./mock-op-server/ (SPEC_03 Increment 3). Everything the legacy static mock
 * exported still comes from here: startMockOpServer, mockOpServer,
 * createRecordingMockOpServer, RecordedRequest, RecordingMockOpServer,
 * UNREACHABLE_OP_URL, SECOND_MOCK_OP_PORT — plus the new scenario engine
 * surface (ScenarioEngine, createMockOpHandler, …).
 *
 * Run:  pnpm --filter @osp/fixtures start   (or: pnpm mock:op)
 * Env:  MOCK_OP_PORT (default 8099), MOCK_OP_HOST (default 127.0.0.1),
 *       MOCK_OP_LOG=1 to log requests.
 */

export * from "./mock-op-server/index";

// Auto-start when run directly (tsx mock-op-server.ts).
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  startMockOpServer();
}

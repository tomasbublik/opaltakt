import { describe, expect, it } from "vitest";
import { ErrorCode, Sprint } from "@osp/contracts";

/**
 * Placeholder — proves the test harness + contract imports resolve.
 * Agent D replaces this with: A↔B integration, read-only guard, burndown math,
 * and the Playwright e2e main flow (SPEC §9).
 */
describe("phase 0 skeleton", () => {
  it("exposes the contract package", () => {
    expect(ErrorCode.options).toContain("READ_ONLY_VIOLATION");
    expect(Sprint.shape.status).toBeDefined();
  });
});

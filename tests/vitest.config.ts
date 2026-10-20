import { defineConfig } from "vitest/config";

// Integration + read-only guard tests live here (Agent D). e2e uses Playwright.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});

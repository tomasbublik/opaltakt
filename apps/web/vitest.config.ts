import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { buildDefines } from "./buildInfo";

// Dedicated Vitest config so component tests run in jsdom with jest-dom
// matchers. `vite build` / `vite dev` keep using vite.config.ts.
export default defineConfig({
  plugins: [react()],
  define: buildDefines(),
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

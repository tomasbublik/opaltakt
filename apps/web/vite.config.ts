import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { buildDefines } from "./buildInfo";

// Frontend calls ONLY the local backend (SPEC §2 — token never reaches browser).
export default defineConfig({
  plugins: [react()],
  define: buildDefines(),
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL ?? "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});

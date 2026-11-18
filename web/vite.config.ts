import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In development the SPA proxies /api to a local API; in compose, nginx does the same.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": process.env.API_URL ?? "http://localhost:3000" } },
  test: { environment: "jsdom", setupFiles: ["src/test-setup.ts"] },
});

import { defineConfig } from "vitest/config";

// Functional tests against a running compose stack: `docker compose up -d --build`, then `npm run test:e2e`.
export default defineConfig({
  test: { include: ["e2e/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 },
});

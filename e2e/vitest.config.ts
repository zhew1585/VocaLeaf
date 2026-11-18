import { defineConfig } from "vitest/config";

// Functional tests against a running compose stack: `npm run e2e:up` (short job lease), then `npm run test:e2e`.
// Files run one at a time because the lease tests stop and restart the worker.
export default defineConfig({
  test: { include: ["e2e/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false },
});

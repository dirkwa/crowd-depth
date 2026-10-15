import { defineConfig } from "vitest/config";

// The end-to-end suite boots a real Signal K server, so it runs on its own
// (npm run test:e2e) rather than with the unit tests.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});

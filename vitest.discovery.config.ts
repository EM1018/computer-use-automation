import { defineConfig } from "vitest/config";

// Separate from the default suite (npm test / vitest.config.ts) on purpose:
// discovery is slow and, for the mocked-model tests, still spins up a real
// browser + the target app per scenario. Run via `npm run test:discovery`.
export default defineConfig({
  test: {
    include: ["test/discovery/**/*.test.ts"],
    testTimeout: 30000,
  },
});

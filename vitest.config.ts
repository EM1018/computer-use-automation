import { defineConfig } from "vitest/config";

// Discovery tests are slow (real model calls or, for the mocked-model
// suite, a real browser per scenario) and live under test/discovery/,
// covered by npm run test:discovery (see vitest.discovery.config.ts)
// instead — kept out of the default run.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "test/discovery/**"],
  },
});

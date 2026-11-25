import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/env.ts"],
    // The Git tests drive real git processes in temp repositories.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
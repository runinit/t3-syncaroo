import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["repos/**", "node_modules/**", "dist/**"],
    setupFiles: ["./test/v2-pinned-requirements.ts"],
    maxWorkers: 2,
    minWorkers: 1,
  },
});

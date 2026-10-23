import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    hookTimeout: 60_000, // first in-process Postgres start per file is slow when files run in parallel
    testTimeout: 30_000,
    env: { DATABASE_URL: "", PGLITE_DIR: "", NOW_OVERRIDE: "2026-10-23 10:00", STAFF_WEBHOOK_URL: "" },
  },
});

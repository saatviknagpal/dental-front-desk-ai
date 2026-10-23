import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    env: { DATABASE_URL: "", PGLITE_DIR: "", NOW_OVERRIDE: "2026-10-23 10:00", STAFF_WEBHOOK_URL: "" },
  },
});

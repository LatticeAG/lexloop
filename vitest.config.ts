import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    exclude: ["**/fixtures/**", "**/node_modules/**", "**/dist/**"],
  },
});

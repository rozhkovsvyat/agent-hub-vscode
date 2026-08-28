import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // Extension contract tests must exercise this checkout's protocol/core,
    // not the last packed file: dependency that happens to be installed.
    alias: {
      core: path.resolve(__dirname, "../../core"),
    },
  },
  test: {
    include: ["**/*.vitest.ts"],
    environment: "node",
  },
});

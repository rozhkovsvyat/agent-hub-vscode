import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // Tests must exercise this checkout's core, not the packed file: dependency.
    alias: {
      core: path.resolve(__dirname, "../../core"),
    },
  },
  test: {
    globals: true,
    include: ["src/**/*.vitest.ts"],
    environment: "node",
  },
});

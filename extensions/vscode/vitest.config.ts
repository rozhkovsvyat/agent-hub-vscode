import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // Extension contract tests must exercise this checkout's protocol/core,
    // not the last packed file: dependency that happens to be installed.
    alias: {
      core: path.resolve(__dirname, "../../core"),
      // The vendor bridge is an installed git dependency now; the alias points
      // at its shipped TypeScript sources so contract tests and mocks keep
      // working on the same module ids the package uses internally.
      "@cukii/vendor-bridge": path.resolve(
        __dirname,
        "node_modules/@cukii/vendor-bridge/src/index.ts",
      ),
    },
  },
  test: {
    include: ["**/*.vitest.ts"],
    environment: "node",
  },
});

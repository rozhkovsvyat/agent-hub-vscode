export default {
  rootDir: "..",
  transform: {
    "^.+\\.(ts|js)$": ["ts-jest", { useESM: true, isolatedModules: true }],
  },
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1", "^uuid$": "uuid" },
  extensionsToTreatAsEsm: [".ts"],
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  // The parent asserts the operation-only migration SLA. This child also pays
  // one-time Jest/TypeScript startup, so its harness timeout must not mask it.
  testTimeout: 60000,
  maxWorkers: 1,
  testMatch: ["**/history.child-process.test.ts"],
  forceExit: true,
};

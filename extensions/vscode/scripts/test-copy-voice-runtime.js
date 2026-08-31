const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  copySharpRuntime,
  getSharpNativeBindingPath,
  validateSharpNativeBinding,
} = require("./esbuild");

const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "cukii-sharp-runtime-test-"),
);

try {
  const sourceModules = path.join(fixtureRoot, "source", "node_modules");
  const sourceSharp = path.join(sourceModules, "sharp");
  const outputModules = path.join(fixtureRoot, "out", "node_modules");
  fs.mkdirSync(sourceSharp, { recursive: true });
  fs.writeFileSync(
    path.join(sourceSharp, "package.json"),
    JSON.stringify({ name: "sharp", version: "0.32.6" }),
  );

  assert.throws(
    () => copySharpRuntime(outputModules, sourceModules),
    /Missing target-specific sharp native binding/,
    "packaging must fail when sharp's copied native binding is missing",
  );

  const invalidBinding = getSharpNativeBindingPath(sourceModules);
  fs.mkdirSync(path.dirname(invalidBinding), { recursive: true });
  fs.writeFileSync(invalidBinding, "not a native module");
  assert.throws(
    () => copySharpRuntime(outputModules, sourceModules),
    /Copied sharp native binding is unloadable/,
    "packaging must load, not merely find, sharp's copied native binding",
  );

  validateSharpNativeBinding(path.join(__dirname, "..", "node_modules"));
  console.log("sharp runtime copy guards passed");
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

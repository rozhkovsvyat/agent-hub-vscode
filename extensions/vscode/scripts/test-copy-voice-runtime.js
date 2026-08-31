const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const { createRequire } = require("module");
const path = require("path");

const { copySharpRuntime, getSharpNativeBindingPath } = require("./esbuild");

async function exerciseCopiedSharp(packageJson) {
  const copiedModules = path.dirname(path.dirname(packageJson));
  const copiedRequire = createRequire(packageJson);
  const sharp = copiedRequire("sharp");
  const sharpPath = copiedRequire.resolve("sharp");
  const relativeSharpPath = path.relative(copiedModules, sharpPath);
  assert.ok(
    !path.isAbsolute(relativeSharpPath) && !relativeSharpPath.startsWith(".."),
    `sharp resolved outside the copied runtime: ${sharpPath}`,
  );

  const png = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  assert.strictEqual(png.subarray(1, 4).toString(), "PNG");
}

async function main() {
  const [command, packageJson] = process.argv.slice(2);
  if (command === "--exercise-copied-sharp") {
    await exerciseCopiedSharp(packageJson);
    return;
  }

  const fixtureRoot = fs.mkdtempSync(
    path.join("D:\\Scratch", "cukii-sharp-runtime-test-"),
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

    const packagedModules = path.join(fixtureRoot, "packaged", "node_modules");
    copySharpRuntime(packagedModules);
    const exercise = spawnSync(
      process.execPath,
      [
        __filename,
        "--exercise-copied-sharp",
        path.join(packagedModules, "sharp", "package.json"),
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.strictEqual(
      exercise.status,
      0,
      exercise.stderr ||
        exercise.error?.message ||
        "copied sharp exercise failed",
    );
    console.log("sharp runtime copy guards passed");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require("node:assert/strict");
const test = require("node:test");

const { packageAll } = require("./package-all");
const { packageExtension, parsePackageArgs } = require("./package");

test("rejects a hostile package target before any command is launched", () => {
  const marker = "__cukii_package_target_injection_marker__";
  let executed = false;

  assert.throws(
    () =>
      packageExtension({
        args: ["--target", `linux-x64; ${marker}`],
        runVsce() {
          executed = true;
        },
      }),
    /Unsupported VS Code package target/,
  );
  assert.equal(executed, false);
  assert.equal(parsePackageArgs(["--target", "linux-x64"]).target, "linux-x64");
});

test("package-all prepares fresh GUI staging once before every target", () => {
  let stagedAsset = "stale";
  let prepareCount = 0;
  const commands = [];

  packageAll({
    platforms: ["linux-x64", "darwin-arm64"],
    prepareGui() {
      prepareCount += 1;
      stagedAsset = "current";
    },
    runCommand(_command, args, options) {
      assert.equal(stagedAsset, "current");
      assert.equal(options.shell, false);
      commands.push(args);
    },
  });

  assert.equal(prepareCount, 1);
  assert.equal(commands.length, 4);
  assert.deepEqual(commands[0].slice(-3), [
    "--target",
    "linux-x64",
    "--gui-prepared",
  ]);
  assert.deepEqual(commands[2].slice(-3), [
    "--target",
    "darwin-arm64",
    "--gui-prepared",
  ]);
});

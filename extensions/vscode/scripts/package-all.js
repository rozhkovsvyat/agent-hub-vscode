const { execFileSync } = require("child_process");
const path = require("path");

const { buildAndCopyGui } = require("./build-copy-gui");

const HOST_TARGET = `${process.platform}-${process.arch}`;
const SUPPORTED_PLATFORMS = [
  "win32-x64",
  // "win32-arm64", can't be built due to no sqlite3 binaries
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
];
// Every target rebuilds the shared `out/` tree. Keep the build host last so the
// source output left behind is the exact output packaged into the host carrier;
// activation then binds that carrier byte-for-byte to this worktree instead of
// accidentally comparing it with the final foreign target's bundle.
const PLATFORMS = [
  ...SUPPORTED_PLATFORMS.filter((target) => target !== HOST_TARGET),
  ...SUPPORTED_PLATFORMS.filter((target) => target === HOST_TARGET),
];

function packageAll({
  args = process.argv.slice(2),
  platforms = PLATFORMS,
  prepareGui = buildAndCopyGui,
  runCommand = execFileSync,
} = {}) {
  const isPreRelease = args.includes("--pre-release");
  if (args.some((arg) => arg !== "--pre-release")) {
    throw new Error("package-all only accepts --pre-release");
  }

  // The GUI is target-independent. Build and transactionally stage it once,
  // then allow each platform's prepackage to consume that verified staging.
  prepareGui();

  const driver = path.join(__dirname, "package-cross-target.js");
  let buildError;
  try {
    for (const platform of platforms) {
      const packageArgs = [driver, "--target", platform, "--gui-prepared"];
      if (isPreRelease) {
        packageArgs.push("--pre-release");
      }
      runCommand(process.execPath, packageArgs, {
        stdio: "inherit",
        shell: false,
      });
    }
  } catch (error) {
    buildError = error;
  }

  try {
    // Each target replaces native modules in-place. Restore the build host even
    // when a target fails, otherwise the next local test/load uses foreign code.
    runCommand(process.execPath, [driver, "--restore-host"], {
      stdio: "inherit",
      shell: false,
    });
  } catch (restoreError) {
    if (buildError) {
      throw new AggregateError(
        [buildError, restoreError],
        "Cross-target packaging and host restoration both failed",
      );
    }
    throw restoreError;
  }

  if (buildError) {
    throw buildError;
  }
}

if (require.main === module) {
  packageAll();
}

module.exports = { HOST_TARGET, PLATFORMS, SUPPORTED_PLATFORMS, packageAll };

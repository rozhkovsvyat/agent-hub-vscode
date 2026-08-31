const { execFileSync } = require("child_process");
const path = require("path");

const { buildAndCopyGui } = require("./build-copy-gui");

const PLATFORMS = [
  "win32-x64",
  // "win32-arm64", can't be built due to no sqlite3 binaries
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
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

  for (const platform of platforms) {
    runCommand(
      process.execPath,
      [
        path.join(__dirname, "prepackage-cross-platform.js"),
        "--target",
        platform,
        "--gui-prepared",
      ],
      { stdio: "inherit", shell: false },
    );
    const packageArgs = [path.join(__dirname, "package.js")];
    if (isPreRelease) {
      packageArgs.push("--pre-release");
    }
    packageArgs.push("--target", platform);
    runCommand(process.execPath, packageArgs, {
      stdio: "inherit",
      shell: false,
    });
  }
}

if (require.main === module) {
  packageAll();
}

module.exports = { PLATFORMS, packageAll };

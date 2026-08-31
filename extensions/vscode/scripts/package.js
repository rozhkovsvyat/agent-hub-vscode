const { execFileSync } = require("child_process");
const fs = require("fs");

const SUPPORTED_TARGETS = new Set([
  "win32-x64",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
  "linux-armhf",
  "alpine-x64",
  "alpine-arm64",
  "darwin-x64",
  "darwin-arm64",
]);

function parsePackageArgs(args) {
  let target;
  let isPreRelease = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pre-release") {
      isPreRelease = true;
    } else if (arg === "--target") {
      target = args[index + 1];
      index += 1;
      if (!target || target.startsWith("--")) {
        throw new Error("--target requires a supported VS Code target");
      }
    } else {
      throw new Error(`Unsupported package argument: ${arg}`);
    }
  }

  if (target && !SUPPORTED_TARGETS.has(target)) {
    throw new Error(`Unsupported VS Code package target: ${target}`);
  }

  return { target, isPreRelease };
}

function packageExtension({
  args = process.argv.slice(2),
  runVsce = execFileSync,
} = {}) {
  const version = JSON.parse(
    fs.readFileSync("./package.json", { encoding: "utf-8" }),
  ).version;
  const { target, isPreRelease } = parsePackageArgs(args);

  fs.mkdirSync("build", { recursive: true });

  const vsceArgs = [
    require.resolve("@vscode/vsce/vsce"),
    "package",
    "--out",
    "./build",
    "--no-dependencies",
  ];
  if (isPreRelease) {
    vsceArgs.push("--pre-release");
  }
  if (target) {
    vsceArgs.push("--target", target);
  }

  runVsce(process.execPath, vsceArgs, { stdio: "inherit", shell: false });
  console.log(
    `vsce package completed - extension created at extensions/vscode/build/cukii-vscode-${version}.vsix`,
  );
}

if (require.main === module) {
  packageExtension();
}

module.exports = { SUPPORTED_TARGETS, packageExtension, parsePackageArgs };

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TARGETS = [
  "win32-x64",
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
];
const EXTENSION_ID = "cukii.cukii-vscode";
const DUPLICATE_PATTERN =
  /Target platform .* already exists and cannot be modified/i;

function parseArgs(args) {
  const parsed = { preRelease: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pre-release") {
      parsed.preRelease = true;
    } else if (arg === "--vsix-dir" || arg === "--version") {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      parsed[arg === "--vsix-dir" ? "vsixDir" : "version"] = value;
      index += 1;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  if (!parsed.vsixDir || !parsed.version) {
    throw new Error("--vsix-dir and --version are required");
  }
  return parsed;
}

function collectTargetVsix(vsixDir, version) {
  const expected = TARGETS.map((target) => ({
    target,
    filePath: path.resolve(vsixDir, `cukii-vscode-${target}-${version}.vsix`),
  }));
  const missing = expected.filter(({ filePath }) => !fs.existsSync(filePath));
  if (missing.length > 0) {
    throw new Error(
      `Missing target VSIX files: ${missing.map(({ target }) => target).join(", ")}`,
    );
  }
  return expected;
}

function runVscePublish({ filePath, preRelease }) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = [
    "--yes",
    "@vscode/vsce",
    "publish",
    "--no-dependencies",
    "--packagePath",
    filePath,
  ];
  if (preRelease) args.splice(3, 0, "--pre-release");
  const result = spawnSync(npx, args, { encoding: "utf8", env: process.env });
  return {
    status: result.status ?? 1,
    output: `${result.stdout || ""}\n${result.stderr || ""}`,
  };
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function publishEveryTarget({
  packages,
  preRelease = false,
  maxAttempts = 3,
  runPublish = runVscePublish,
  wait = delay,
}) {
  const failures = [];
  for (const pkg of packages) {
    let accepted = false;
    let lastOutput = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await runPublish({
        filePath: pkg.filePath,
        target: pkg.target,
        preRelease,
        attempt,
      });
      lastOutput = result.output || "";
      process.stdout.write(lastOutput);
      if (result.status === 0 || DUPLICATE_PATTERN.test(lastOutput)) {
        accepted = true;
        break;
      }
      if (attempt < maxAttempts) await wait(attempt * 10_000);
    }
    if (!accepted) failures.push(`${pkg.target}: ${lastOutput.trim()}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `Marketplace publication incomplete:\n${failures.join("\n")}`,
    );
  }
}

async function queryGalleryVersions({ fetchImpl = fetch } = {}) {
  const body = {
    filters: [
      {
        criteria: [{ filterType: 7, value: EXTENSION_ID }],
        pageNumber: 1,
        pageSize: 1,
      },
    ],
    flags: 914,
  };
  const response = await fetchImpl(
    "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
    {
      method: "POST",
      headers: {
        Accept: "application/json;api-version=7.2-preview.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok)
    throw new Error(`Gallery query failed: HTTP ${response.status}`);
  const payload = await response.json();
  return payload.results?.[0]?.extensions?.[0]?.versions || [];
}

async function waitForValidatedTargets({
  version,
  queryVersions = queryGalleryVersions,
  wait = delay,
  intervalMs = 15_000,
  timeoutMs = 30 * 60_000,
  requiredConsecutive = 2,
}) {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  let lastState = "";
  while (Date.now() < deadline) {
    const versions = await queryVersions();
    const matching = versions.filter((item) => item.version === version);
    const validated = new Set(
      matching
        .filter((item) => String(item.flags).split(",").includes("validated"))
        .map((item) => item.targetPlatform),
    );
    const missing = TARGETS.filter((target) => !validated.has(target));
    const state = `validated=${validated.size}/5 missing=${missing.join(",")}`;
    if (state !== lastState) console.log(state);
    lastState = state;
    consecutive = missing.length === 0 ? consecutive + 1 : 0;
    if (consecutive >= requiredConsecutive) {
      console.log("CUKII-MARKETPLACE-FIVE-TARGETS-PASS");
      return;
    }
    await wait(intervalMs);
  }
  throw new Error(`Marketplace validation timed out: ${lastState}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packages = collectTargetVsix(options.vsixDir, options.version);
  await publishEveryTarget({ packages, preRelease: options.preRelease });
  await waitForValidatedTargets({ version: options.version });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DUPLICATE_PATTERN,
  TARGETS,
  collectTargetVsix,
  parseArgs,
  publishEveryTarget,
  waitForValidatedTargets,
};

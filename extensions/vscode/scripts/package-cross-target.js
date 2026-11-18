/**
 * @file Build a VSIX for one VS Code target platform from any build host.
 *
 * Runs the normal `prepackage.js` / `package.js` pair, but stages every
 * host-derived native input for the requested target first and then refuses to
 * package anything foreign. See `cross-target-packaging.js` for why each step
 * exists.
 *
 * Usage: node scripts/package-cross-target.js --target darwin-arm64
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { rimrafSync } = require("rimraf");

const { copySqlite } = require("./download-copy-sqlite");
const { installAndCopyNodeModules } = require("./install-copy-nodemodule");
const {
  CROSS_TARGETS,
  ffmpegBinaryName,
  lancedbDirectoryName,
  lancedbPackageName,
  lancedbVersionForTarget,
  pruneForeignNativeModules,
  readWrapperManifest,
  ripgrepBinaryName,
  sharpBindingName,
  stageFfmpegForTarget,
  stageRipgrepForTarget,
  stageSharpForTarget,
} = require("./cross-target-packaging");
const { patchVsixExecutableModes } = require("./zip-executable-mode");

const extensionDir = path.join(__dirname, "..");

const HOST_TARGET = `${process.platform}-${process.arch}`;

function parseArgs(args) {
  let target;
  let restoreHost = false;
  let preRelease = false;
  let guiPrepared = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--target") {
      target = args[index + 1];
      index += 1;
    } else if (args[index] === "--restore-host") {
      restoreHost = true;
    } else if (args[index] === "--pre-release") {
      preRelease = true;
    } else if (args[index] === "--gui-prepared") {
      guiPrepared = true;
    } else {
      throw new Error(`Unsupported argument: ${args[index]}`);
    }
  }
  if (restoreHost) {
    if (target || preRelease || guiPrepared) {
      throw new Error(
        "--restore-host cannot be combined with packaging arguments",
      );
    }
    return {
      target: HOST_TARGET,
      restoreHost: true,
      preRelease: false,
      guiPrepared: false,
    };
  }
  if (!target) {
    throw new Error(
      `--target is required (one of: ${CROSS_TARGETS.join(", ")})`,
    );
  }
  if (!CROSS_TARGETS.includes(target)) {
    throw new Error(
      `Unsupported target ${target} (one of: ${CROSS_TARGETS.join(", ")})`,
    );
  }
  return { target, restoreHost: false, preRelease, guiPrepared };
}

async function ensureLancedbForTarget(
  target,
  {
    extensionRoot = extensionDir,
    fileSystem = fs,
    install = installAndCopyNodeModules,
    remove = rimrafSync,
  } = {},
) {
  const nodeModulesDir = path.join(extensionRoot, "node_modules");
  const pruned = pruneForeignNativeModules(nodeModulesDir, target, {
    fileSystem,
    remove,
  });
  if (pruned.length > 0) {
    console.log(`[info] Pruned native modules: ${pruned.join(", ")}`);
  }

  const packageName = lancedbPackageName(target);
  const directoryName = lancedbDirectoryName(target);
  const lancedbDir = path.join(nodeModulesDir, "@lancedb", directoryName);
  const expectedVersion = lancedbVersionForTarget(
    target,
    readWrapperManifest(extensionRoot),
  );
  const nativeManifestPath = path.join(lancedbDir, "package.json");
  let installedVersion;
  if (fileSystem.existsSync(nativeManifestPath)) {
    installedVersion = JSON.parse(
      fileSystem.readFileSync(nativeManifestPath, "utf8"),
    ).version;
  }

  if (installedVersion !== expectedVersion) {
    if (fileSystem.existsSync(lancedbDir)) {
      console.log(
        `[info] Replacing ${packageName}@${installedVersion ?? "unknown"}; expected ${expectedVersion}`,
      );
      remove(lancedbDir);
    }
    console.log(`[info] Installing ${packageName}@${expectedVersion}`);
    await install(packageName, "@lancedb", expectedVersion);
  }

  if (!fileSystem.existsSync(nativeManifestPath)) {
    throw new Error(`Failed to install LanceDB binary at ${lancedbDir}`);
  }
  const finalVersion = JSON.parse(
    fileSystem.readFileSync(nativeManifestPath, "utf8"),
  ).version;
  if (finalVersion !== expectedVersion) {
    throw new Error(
      `LanceDB native version mismatch for ${target}: ${finalVersion}, expected ${expectedVersion}`,
    );
  }
  return lancedbDir;
}

/**
 * Put the host's own native modules back.
 *
 * Cross-packaging overwrites shared trees in place - `core/node_modules/sqlite3`,
 * `ffmpeg-static`, `sharp`, `@vscode/ripgrep` - because that is how the normal
 * pipeline stages binaries. After a linux-arm64 build the working tree therefore
 * holds ELF objects, and every host test that loads sqlite3 or ffmpeg fails with
 * "is not a valid Win32 application". That is the build's doing, not a product
 * regression, and it has to be undone explicitly rather than remembered.
 */
async function restoreHostNativeModules() {
  process.chdir(extensionDir);
  console.log(`[info] Restoring host native modules for ${HOST_TARGET}`);
  await stageRipgrepForTarget(HOST_TARGET, { extensionDir });
  stageFfmpegForTarget(HOST_TARGET, { extensionDir });
  stageSharpForTarget(HOST_TARGET, { extensionDir });
  await ensureLancedbForTarget(HOST_TARGET);
  await copySqlite(HOST_TARGET);
  console.log(`[info] Host native modules restored`);
}

function runNodeScript(script, scriptArgs, env) {
  execFileSync(
    process.execPath,
    [path.join(__dirname, script), ...scriptArgs],
    {
      cwd: extensionDir,
      stdio: "inherit",
      shell: false,
      env: { ...process.env, ...env },
    },
  );
}

async function packageCrossTarget(
  target,
  { preRelease = false, guiPrepared = false } = {},
) {
  console.log(`[info] Cross-packaging for ${target}`);
  process.chdir(extensionDir);

  await stageRipgrepForTarget(target, { extensionDir });

  // The voice runtime is staged by esbuild, which runs inside `vsce package`
  // and therefore after every check this driver could make. Download its two
  // host-bound inputs up front so that step has nothing left to guess.
  console.log(`[info] Staging ffmpeg for ${target}`);
  stageFfmpegForTarget(target, { extensionDir });
  console.log(`[info] Staging sharp for ${target}`);
  stageSharpForTarget(target, { extensionDir });

  const nodeModulesDir = path.join(extensionDir, "node_modules");
  // Leave only the target's exact native package behind before prepackage copies
  // the whole @lancedb directory into out/. Existence alone is insufficient: an
  // older build can leave the right directory name with an incompatible ABI.
  await ensureLancedbForTarget(target);

  await copySqlite(target);

  // Every target-specific download is already staged, so prepackage must not
  // run its own installs: on a cross host they either rebuild native modules
  // for the wrong platform or fail outright.
  runNodeScript("prepackage.js", ["--target", target], {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    SKIP_INSTALLS: "true",
    // eslint-disable-next-line @typescript-eslint/naming-convention
    CONTINUE_VSCODE_TARGET: target,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    CUKII_GUI_PREPARED: guiPrepared ? "true" : "false",
  });

  const outNodeModules = path.join(extensionDir, "out", "node_modules");
  const prunedAfter = pruneForeignNativeModules(outNodeModules, target);
  if (prunedAfter.length > 0) {
    console.log(
      `[info] Pruned staged native modules: ${prunedAfter.join(", ")}`,
    );
  }

  const stagedRipgrep = path.join(
    outNodeModules,
    "@vscode",
    "ripgrep",
    "bin",
    ripgrepBinaryName(target),
  );
  const stagedLancedb = path.join(
    outNodeModules,
    "@lancedb",
    lancedbDirectoryName(target),
    "index.node",
  );
  for (const required of [stagedRipgrep, stagedLancedb]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Staged artifact missing for ${target}: ${required}`);
    }
  }

  // The temp directory install-copy-nodemodule uses is removed by its own
  // finally block; drop it defensively so it can never reach the VSIX.
  rimrafSync(path.join(extensionDir, "tmp"));

  // vsce runs `vscode:prepublish` -> esbuild, which stages the voice runtime.
  // Without the target in its environment it falls back to the build host.
  const packageArgs = ["--target", target];
  if (preRelease) {
    packageArgs.unshift("--pre-release");
  }
  runNodeScript("package.js", packageArgs, {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    CONTINUE_VSCODE_TARGET: target,
  });

  const version = JSON.parse(
    fs.readFileSync(path.join(extensionDir, "package.json"), "utf8"),
  ).version;
  const vsixPath = path.join(
    extensionDir,
    "build",
    `cukii-vscode-${target}-${version}.vsix`,
  );
  if (!target.startsWith("win32")) {
    const patched = patchVsixExecutableModes(vsixPath);
    console.log(`[info] Patched Unix executable modes: ${patched.join(", ")}`);
  }

  const voiceRuntime = path.join(
    extensionDir,
    "out",
    "runtime",
    ffmpegBinaryName(target),
  );
  const voiceSharp = path.join(
    outNodeModules,
    "sharp",
    "build",
    "Release",
    sharpBindingName(target),
  );
  for (const required of [voiceRuntime, voiceSharp]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Voice runtime missing for ${target}: ${required}`);
    }
  }
  console.log(`[info] Cross-packaging for ${target} completed`);
}

if (require.main === module) {
  const { target, restoreHost, preRelease, guiPrepared } = parseArgs(
    process.argv.slice(2),
  );
  const run = restoreHost
    ? restoreHostNativeModules()
    : packageCrossTarget(target, { preRelease, guiPrepared });
  run.then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}

module.exports = {
  ensureLancedbForTarget,
  packageCrossTarget,
  parseArgs,
  restoreHostNativeModules,
};

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

const extensionDir = path.join(__dirname, "..");

const HOST_TARGET = `${process.platform}-${process.arch}`;

function parseArgs(args) {
  let target;
  let restoreHost = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--target") {
      target = args[index + 1];
      index += 1;
    } else if (args[index] === "--restore-host") {
      restoreHost = true;
    } else {
      throw new Error(`Unsupported argument: ${args[index]}`);
    }
  }
  if (restoreHost) {
    return { target: HOST_TARGET, restoreHost: true };
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
  return { target, restoreHost: false };
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
  console.log(`[info] Restoring host native modules for ${HOST_TARGET}`);
  await stageRipgrepForTarget(HOST_TARGET, { extensionDir });
  stageFfmpegForTarget(HOST_TARGET, { extensionDir });
  stageSharpForTarget(HOST_TARGET, { extensionDir });
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

async function packageCrossTarget(target) {
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

  // Leave only the target's native module behind before prepackage copies the
  // whole @lancedb directory into out/.
  const nodeModulesDir = path.join(extensionDir, "node_modules");
  const prunedBefore = pruneForeignNativeModules(nodeModulesDir, target);
  if (prunedBefore.length > 0) {
    console.log(
      `[info] Pruned host native modules: ${prunedBefore.join(", ")}`,
    );
  }

  const lancedbDir = path.join(
    nodeModulesDir,
    "@lancedb",
    lancedbDirectoryName(target),
  );
  if (!fs.existsSync(lancedbDir)) {
    const packageName = lancedbPackageName(target);
    const version = lancedbVersionForTarget(
      target,
      readWrapperManifest(extensionDir),
    );
    console.log(`[info] Installing ${packageName}@${version}`);
    await installAndCopyNodeModules(packageName, "@lancedb", version);
    if (!fs.existsSync(lancedbDir)) {
      throw new Error(`Failed to install LanceDB binary at ${lancedbDir}`);
    }
  }

  await copySqlite(target);

  // Every target-specific download is already staged, so prepackage must not
  // run its own installs: on a cross host they either rebuild native modules
  // for the wrong platform or fail outright.
  runNodeScript("prepackage.js", ["--target", target], {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    SKIP_INSTALLS: "true",
    // eslint-disable-next-line @typescript-eslint/naming-convention
    CONTINUE_VSCODE_TARGET: target,
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
  runNodeScript("package.js", ["--target", target], {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    CONTINUE_VSCODE_TARGET: target,
  });

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
  const { target, restoreHost } = parseArgs(process.argv.slice(2));
  const run = restoreHost
    ? restoreHostNativeModules()
    : packageCrossTarget(target);
  run.then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}

module.exports = { packageCrossTarget, parseArgs, restoreHostNativeModules };

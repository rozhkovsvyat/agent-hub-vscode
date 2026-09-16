const { execFileSync, fork } = require("child_process");
const fs = require("fs");
const path = require("path");

const { ProxyAgent } = require("undici");
const { rimrafSync } = require("rimraf");

const { execCmdSync } = require("../../../scripts/util");

const {
  isForkedChildOperation,
  runChildOperation,
  sendChildResult,
} = require("./child-operation");
const {
  assertRipgrepArchiveSignature,
  ripgrepExtractionPlan,
} = require("./cross-target-packaging");

/**
 * download a file using fetch API
 * @param {string} url
 * @param {string} outputPath
 */
async function downloadFile(url, outputPath) {
  // Use proxy if set in environment variables
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  const agent = proxy ? new ProxyAgent(proxy) : undefined;

  const response = await fetch(url, {
    redirect: "follow", // Automatically follow redirects
    dispatcher: agent,
  });

  if (!response.ok) {
    throw new Error(`Failed to download file, status code: ${response.status}`);
  }

  // Create output directory if it doesn't exist
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Get the response as an array buffer and write it to the file
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
}

/**
 *
 * @param {string} target platform specific target
 * @param {string} targetDir the directory to download into
 */
async function downloadSqlite(target, targetDir) {
  const downloadUrl =
    // node-sqlite3 doesn't have a pre-built binary for win32-arm64
    target === "win32-arm64"
      ? "https://continue-server-binaries.s3.us-west-1.amazonaws.com/win32-arm64/node_sqlite3.tar.gz"
      : `https://github.com/TryGhost/node-sqlite3/releases/download/v5.1.7/sqlite3-v5.1.7-napi-v6-${
          target
        }.tar.gz`;
  await downloadFile(downloadUrl, targetDir);
}

async function installAndCopySqlite(
  target,
  {
    execute = execFileSync,
    platform = process.platform,
    environment = process.env,
    download = downloadSqlite,
    sqliteDir: suppliedSqliteDir,
  } = {},
) {
  // Replace the installed with pre-built
  console.log("[info] Downloading pre-built sqlite3 binary");
  // pnpm installs `core/node_modules/sqlite3` as a symlink into the store, and
  // GNU tar refuses to write through one ("Cannot extract through symlink"),
  // which failed the whole prepackage. Resolve to the real store directory
  // first; on a plain npm tree realpath is a no-op.
  const sqliteDir = suppliedSqliteDir
    ? fs.realpathSync(suppliedSqliteDir)
    : fs.realpathSync("../../core/node_modules/sqlite3");
  rimrafSync(path.join(sqliteDir, "build"));
  const archive = path.join(sqliteDir, "build.tar.gz");
  await download(target, archive);
  assertRipgrepArchiveSignature(archive);
  // Git Bash prepends GNU tar to PATH on Windows; with a drive-letter argument
  // it interprets `D:\...` as a remote host. Use the same trusted, local-only
  // extraction plan as ripgrep: System32 bsdtar on Windows, basename in cwd on
  // every platform, and no shell parsing.
  const extraction = ripgrepExtractionPlan(sqliteDir, archive, {
    platform,
    environment,
  });
  execute(extraction.command, extraction.args, {
    cwd: extraction.cwd,
    stdio: "inherit",
    shell: false,
  });
  fs.unlinkSync(archive);
}

async function installAndCopyEsbuild(target) {
  // Download and unzip esbuild
  console.log("[info] Downloading pre-built esbuild binary");
  rimrafSync("node_modules/@esbuild");
  fs.mkdirSync("node_modules/@esbuild", { recursive: true });
  await downloadFile(
    `https://continue-server-binaries.s3.us-west-1.amazonaws.com/${target}/esbuild.zip`,
    "node_modules/@esbuild/esbuild.zip",
  );
  execCmdSync("cd node_modules/@esbuild && unzip esbuild.zip");
  fs.unlinkSync("node_modules/@esbuild/esbuild.zip");
}

// `copySqlite`/`copyEsbuild` run the work in `fork(__filename)`, so this handler
// belongs to the forked child alone. Registering it unconditionally put it on every
// process that merely *requires* this module for its exports, where it then crashed
// on the first unrelated IPC message ("Cannot destructure property 'operation' of
// 'msg.payload'") - a vitest worker talks to its parent over the same channel, and
// the handler then answered vitest's own traffic with `process.send({error:true})`.
//
// The fork is identified by the shared env marker rather than `require.main ===
// module`: under a custom module loader (vite-node, ts-node, jest) `require.main`
// is not the real entry point, so that test passed inside a vitest worker and the
// handler was installed anyway. See `child-operation.js` for the full rationale.
if (isForkedChildOperation(__filename)) {
  process.once("message", async (msg) => {
    try {
      if (!msg?.payload) {
        throw new Error("Child operation payload is required");
      }
      const { operation, target } = msg.payload;
      if (operation === "sqlite") {
        await installAndCopySqlite(target);
      } else if (operation === "esbuild") {
        await installAndCopyEsbuild(target);
      } else {
        throw new Error(`Unknown download-copy operation: ${String(operation)}`);
      }
      sendChildResult({ done: true }, 0);
    } catch (error) {
      console.error(error);
      sendChildResult({ error: true, message: String(error) }, 1);
    }
  });
}

/**
 * @param {string} target the platform to build for
 */
async function copySqlite(target, options = {}) {
  return runChildOperation({
    forkChild: options.forkChild ?? fork,
    modulePath: __filename,
    cwd: options.cwd ?? process.cwd(),
    payload: { operation: "sqlite", target },
    timeoutMs: options.timeoutMs,
  });
}

/**
 * @param {string} target the platform to build for
 */
async function copyEsbuild(target, options = {}) {
  return runChildOperation({
    forkChild: options.forkChild ?? fork,
    modulePath: __filename,
    cwd: options.cwd ?? process.cwd(),
    payload: { operation: "esbuild", target },
    timeoutMs: options.timeoutMs,
  });
}

module.exports = {
  installAndCopySqlite,
  downloadSqlite,
  copySqlite,
  copyEsbuild,
};

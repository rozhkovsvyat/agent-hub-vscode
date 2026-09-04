const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");

const { ProxyAgent } = require("undici");
const { rimrafSync } = require("rimraf");

const { execCmdSync } = require("../../../scripts/util");

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

async function installAndCopySqlite(target) {
  // Replace the installed with pre-built
  console.log("[info] Downloading pre-built sqlite3 binary");
  // pnpm installs `core/node_modules/sqlite3` as a symlink into the store, and
  // GNU tar refuses to write through one ("Cannot extract through symlink"),
  // which failed the whole prepackage. Resolve to the real store directory
  // first; on a plain npm tree realpath is a no-op.
  const sqliteDir = fs.realpathSync("../../core/node_modules/sqlite3");
  rimrafSync(path.join(sqliteDir, "build"));
  const archive = path.join(sqliteDir, "build.tar.gz");
  await downloadSqlite(target, archive);
  // `-C` rather than `cd &&`: the store may sit on another drive, where a bare
  // `cd` in cmd.exe changes nothing and the extraction lands in the wrong tree.
  execCmdSync(`tar -xvzf "${archive}" -C "${sqliteDir}"`);
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

process.on("message", (msg) => {
  const { operation, target } = msg.payload;
  if (operation === "sqlite") {
    installAndCopySqlite(target)
      .then(() => process.send({ done: true }))
      .catch((error) => {
        console.error(error); // show the error in the parent process
        process.send({ error: true });
      });
  }
  if (operation === "esbuild") {
    installAndCopyEsbuild(target)
      .then(() => process.send({ done: true }))
      .catch((error) => {
        console.error(error); // show the error in the parent process
        process.send({ error: true });
      });
  }
});

/**
 * @param {string} target the platform to build for
 */
async function copySqlite(target) {
  const child = fork(__filename, { stdio: "inherit", cwd: process.cwd() });
  child.send({
    payload: {
      operation: "sqlite",
      target,
    },
  });

  return new Promise((resolve, reject) => {
    child.on("message", (msg) => {
      if (msg.error) {
        reject();
      } else {
        resolve();
      }
    });
  });
}

/**
 * @param {string} target the platform to build for
 */
async function copyEsbuild(target) {
  const child = fork(__filename, { stdio: "inherit", cwd: process.cwd() });
  child.send({
    payload: {
      operation: "esbuild",
      target,
    },
  });

  return new Promise((resolve, reject) => {
    child.on("message", (msg) => {
      if (msg.error) {
        reject();
      } else {
        resolve();
      }
    });
  });
}

module.exports = {
  downloadSqlite,
  copySqlite,
  copyEsbuild,
};

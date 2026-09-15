/**
 * @file Copy lancedb to the current directory. It is also intended to run as a child process.
 */

const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");

const ncp = require("ncp").ncp;
const { rimrafSync } = require("rimraf");

const { execCmdSync } = require("../../../scripts/util");
const { runChildOperation, sendChildResult } = require("./child-operation");

/**
 * @param {string} packageName the module to install
 * @param {string} toCopy directory inside node_modules to copy into
 * @param {string} [version] exact version to install; without it npm resolves
 *   `latest`, which for a native addon means an ABI that its JS wrapper cannot
 *   load on the user's machine
 */
async function installNodeModuleInTempDirAndCopyToCurrent(
  packageName,
  toCopy,
  version,
) {
  console.log(
    `Copying ${packageName}${version ? `@${version}` : ""} to ${toCopy}`,
  );
  // This is a way to install only one package without npm trying to install all the dependencies
  // Create a temporary directory for installing the package
  const adjustedName = packageName.replace(/@/g, "").replace("/", "-");
  const currentDir = process.cwd();
  const tempDir = path.join(
    currentDir,
    "tmp",
    `continue-node_modules-${adjustedName}`,
  );

  // // Remove the dir we will be copying to
  // rimrafSync(`node_modules/${toCopy}`);

  // // Ensure the temporary directory exists
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Move to the temporary directory
    process.chdir(tempDir);

    // Initialize a new package.json and install the package
    const spec = version ? `${packageName}@${version}` : packageName;
    execCmdSync(`npm init -y && npm i -f ${spec} --no-save`);

    console.log(
      `Contents of: ${packageName}`,
      fs.readdirSync(path.join(tempDir, "node_modules", toCopy)),
    );

    // Without this it seems the file isn't completely written to disk
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Remove existing destination directory to ensure fresh copy
    // ncp's clobber option doesn't reliably overwrite cached files
    const packageSubdir = packageName.replace("@lancedb/", "");
    const destDir = path.join(
      currentDir,
      "node_modules",
      toCopy,
      packageSubdir,
    );
    if (fs.existsSync(destDir)) {
      rimrafSync(destDir);
    }

    // Copy the installed package back to the current directory
    await new Promise((resolve, reject) => {
      ncp(
        path.join(tempDir, "node_modules", toCopy),
        path.join(currentDir, "node_modules", toCopy),
        { dereference: true },
        (error) => {
          if (error) {
            console.error(
              `[error] Error copying ${packageName} package`,
              error,
            );
            reject(error);
          } else {
            resolve();
          }
        },
      );
    });
  } finally {
    // Clean up the temporary directory
    try {
      rimrafSync(tempDir);
    } catch (err) {
      console.warn("[warn] Failed to remove temp directory", tempDir, err);
    }

    // Return to the original directory
    process.chdir(currentDir);
  }
}

if (typeof process.send === "function") {
  process.once("message", async (msg) => {
    try {
      await installNodeModuleInTempDirAndCopyToCurrent(
        msg.payload.packageName,
        msg.payload.toCopy,
        msg.payload.version,
      );
      sendChildResult({ done: true }, 0);
    } catch (error) {
      console.error(error);
      sendChildResult({ error: true, message: String(error) }, 1);
    }
  });
}

/**
 * invoke a child process to install a node module into temporary directory and copy it over into node modules
 * @param {string} packageName the module to install and copy
 * @param {string} toCopy directory to copy into inside node modules
 * @param {string} [version] exact version to install
 */
async function installAndCopyNodeModules(packageName, toCopy, version) {
  return runChildOperation({
    forkChild: fork,
    modulePath: __filename,
    cwd: process.cwd(),
    payload: {
      packageName,
      toCopy,
      version,
    },
  });
}

module.exports = {
  installAndCopyNodeModules,
};

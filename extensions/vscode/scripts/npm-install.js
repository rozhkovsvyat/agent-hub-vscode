/**
 * @file Install node modules for the VS Code extension and gui. This is also intended to run as a child process.
 */

const { fork } = require("child_process");
const path = require("path");

const { execCmdSync } = require("../../../scripts/util");

const {
  CHILD_OPERATION_ENV_MARKER,
  isForkedChildOperation,
} = require("./child-operation");
const { continueDir } = require("./utils");

async function installNodeModulesInGui() {
  process.chdir(path.join(continueDir, "gui"));
  execCmdSync("npm install");
  console.log("[info] npm install in gui completed");
}

async function installNodeModulesInVscode() {
  process.chdir(path.join(continueDir, "extensions", "vscode"));
  execCmdSync("npm install");
  console.log("[info] npm install in extensions/vscode completed");
}

// Only the fork owns this handler; see `child-operation.js`. Required as a library
// (for `npmInstall`), this module must add nothing to its host's IPC channel.
if (isForkedChildOperation()) {
  process.on("message", handleWorkerMessage);
}

function handleWorkerMessage(msg) {
  if (!msg || !msg.payload) {
    return;
  }
  const { targetDir } = msg.payload;
  if (targetDir === "gui") {
    installNodeModulesInGui()
      .then(() => process.send({ done: true }))
      .catch((error) => {
        console.error(error); // show the error in the parent process
        process.send({ error: true });
      });
  } else if (targetDir === "vscode") {
    installNodeModulesInVscode()
      .then(() => process.send({ done: true }))
      .catch((error) => {
        console.error(error); // show the error in the parent process
        process.send({ error: true });
      });
  }
}

async function npmInstall() {
  const forkEnv = { ...process.env, [CHILD_OPERATION_ENV_MARKER]: "1" };
  const installVscodeChild = fork(__filename, {
    stdio: "inherit",
    env: forkEnv,
  });
  installVscodeChild.send({ payload: { targetDir: "vscode" } });

  const installGuiChild = fork(__filename, {
    stdio: "inherit",
    env: forkEnv,
  });
  installGuiChild.send({ payload: { targetDir: "gui" } });

  await Promise.all([
    new Promise((resolve, reject) => {
      installVscodeChild.on("message", (msg) => {
        if (msg.error) {
          reject();
        }
        resolve();
      });
    }),
    new Promise((resolve, reject) => {
      installGuiChild.on("message", (msg) => {
        if (msg.error) {
          reject();
        }
        resolve();
      });
    }),
  ]).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  npmInstall,
};

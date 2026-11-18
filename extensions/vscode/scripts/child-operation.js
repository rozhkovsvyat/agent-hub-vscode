/**
 * Marker that tells a build module it is running as the forked worker.
 *
 * These modules are both libraries (`prepackage` requires them for their exports)
 * and their own child processes (`fork(__filename)`). They used to decide which
 * role they were in by `typeof process.send === "function"`, which is true in ANY
 * process that has an IPC channel to its parent - including a vitest worker. The
 * worker handler then ran against vitest's own traffic, read `msg.payload.x` off
 * an unrelated message and killed the test run with
 * "Cannot read properties of undefined". `require.main === module` is no better:
 * under vite-node/ts-node the entry point is the loader, not this file.
 *
 * An env variable we set ourselves at fork time is the only signal a foreign
 * loader or an inherited IPC channel cannot imitate.
 */
const path = require("path");

const CHILD_OPERATION_ENV_MARKER = "CUKII_FORKED_BUILD_WORKER";

function isForkedChildOperation(
  modulePath,
  env = process.env,
  argv = process.argv,
) {
  if (!modulePath || !argv[1]) {
    return false;
  }
  const expected = path.resolve(modulePath);
  return (
    env[CHILD_OPERATION_ENV_MARKER] === expected &&
    path.resolve(argv[1]) === expected
  );
}

function runChildOperation({
  forkChild,
  modulePath,
  payload,
  cwd,
  timeoutMs = 10 * 60 * 1000,
}) {
  let child;
  try {
    child = forkChild(modulePath, {
      stdio: "inherit",
      ...(cwd ? { cwd } : {}),
      env: {
        ...process.env,
        [CHILD_OPERATION_ENV_MARKER]: path.resolve(modulePath),
      },
    });
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let reportedResult;
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onMessage = (message) => {
      reportedResult = message;
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => {
      if (code === 0 && reportedResult?.done === true) {
        finish();
        return;
      }
      const detail = reportedResult?.message
        ? `: ${reportedResult.message}`
        : "";
      finish(
        new Error(
          `Child operation failed (code=${String(code)}, signal=${String(signal)})${detail}`,
        ),
      );
    };

    const timeout = setTimeout(() => {
      if (typeof child.kill === "function") {
        child.kill();
      }
      finish(new Error(`Child operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);

    try {
      child.send({ payload }, (error) => {
        if (error) {
          if (typeof child.kill === "function") {
            child.kill();
          }
          finish(error);
        }
      });
    } catch (error) {
      if (typeof child.kill === "function") {
        child.kill();
      }
      finish(error);
    }
  });
}

function sendChildResult(message, exitCode) {
  process.exitCode = exitCode;
  if (typeof process.send !== "function") {
    return;
  }
  process.send(message, (error) => {
    if (error) {
      process.exitCode = 1;
    }
    if (process.connected) {
      process.disconnect();
    }
  });
}

module.exports = {
  CHILD_OPERATION_ENV_MARKER,
  isForkedChildOperation,
  runChildOperation,
  sendChildResult,
};

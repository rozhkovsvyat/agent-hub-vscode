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

module.exports = { runChildOperation, sendChildResult };

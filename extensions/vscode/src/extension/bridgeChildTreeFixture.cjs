const { spawn } = require("node:child_process");

const grandchild = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000)"],
  {
    stdio: "ignore",
    windowsHide: true,
  },
);

grandchild.once("spawn", () => {
  process.stdout.write(
    `${JSON.stringify({
      parentPid: process.pid,
      grandchildPid: grandchild.pid,
    })}\n`,
  );
});
grandchild.once("error", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});

setInterval(() => {}, 1_000);

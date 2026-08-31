const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildAndCopyGui,
  buildGui,
  expectedNpmRoots,
} = require("./build-copy-gui");

function withFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-gui-package-"));
  try {
    return run({
      guiDir: path.join(root, "gui"),
      vscodeGuiDir: path.join(root, "vscode", "gui"),
      intellijWebviewDir: path.join(root, "intellij", "webview"),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withBuildFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-npm-cli-"));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("runs npm through Node with argv on Windows and POSIX", () => {
  for (const platform of ["win32", "linux"]) {
    withBuildFixture((root) => {
      const nodeExecutable =
        platform === "win32"
          ? path.join(root, "node.exe")
          : path.join(root, "bin", "node");
      const npmRoot = expectedNpmRoots(nodeExecutable, platform)[
        platform === "win32" ? 0 : 1
      ];
      const npmCliPath = path.join(npmRoot, "bin", "npm-cli.js");
      fs.mkdirSync(path.dirname(npmCliPath), { recursive: true });
      fs.writeFileSync(npmCliPath, "// trusted npm cli");

      let invocation;
      buildGui(path.join(root, "gui"), {
        platform,
        nodeExecutable,
        // Exercise the deterministic current-Node fallback on both platforms.
        npmExecPath: "",
        runCommand(...args) {
          invocation = args;
        },
      });

      assert.deepEqual(invocation, [
        nodeExecutable,
        [fs.realpathSync(npmCliPath), "run", "build"],
        { cwd: path.join(root, "gui"), stdio: "inherit", shell: false },
      ]);
    });
  }
});

test("accepts npm_execpath only when it is inside the expected npm root", () => {
  withBuildFixture((root) => {
    const nodeExecutable = path.join(root, "node");
    const npmRoot = path.join(root, "node_modules", "npm");
    const npmCliPath = path.join(npmRoot, "bin", "custom-cli.cjs");
    fs.mkdirSync(path.dirname(npmCliPath), { recursive: true });
    fs.writeFileSync(npmCliPath, "// trusted npm cli");

    let invocation;
    buildGui(path.join(root, "gui"), {
      nodeExecutable,
      npmExecPath: npmCliPath,
      npmRoots: [npmRoot],
      runCommand(...args) {
        invocation = args;
      },
    });

    assert.deepEqual(invocation.slice(0, 2), [
      nodeExecutable,
      [fs.realpathSync(npmCliPath), "run", "build"],
    ]);
  });
});

test("refuses a hostile npm_execpath without executing its marker", () => {
  withBuildFixture((root) => {
    const marker = path.join(root, "executed-marker");
    const hostileCli = path.join(root, "hostile", "npm-cli.js");
    fs.mkdirSync(path.dirname(hostileCli), { recursive: true });
    fs.writeFileSync(
      hostileCli,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")`,
    );
    let runnerCalls = 0;

    assert.throws(
      () =>
        buildGui(path.join(root, "gui"), {
          npmExecPath: hostileCli,
          nodeExecutable: path.join(root, "node"),
          npmRoots: [],
          runCommand() {
            runnerCalls += 1;
          },
        }),
      /GUI build failed: Unable to find a trusted npm CLI script/,
    );
    assert.equal(runnerCalls, 0);
    assert.equal(fs.existsSync(marker), false);
  });
});

test("fails closed when no trusted npm CLI path exists", () => {
  withBuildFixture((root) => {
    let runnerCalls = 0;

    assert.throws(
      () =>
        buildGui(path.join(root, "gui"), {
          npmExecPath: path.join(root, "missing", "npm-cli.js"),
          nodeExecutable: path.join(root, "node"),
          npmRoots: [path.join(root, "node_modules", "npm")],
          runCommand() {
            runnerCalls += 1;
          },
        }),
      /GUI build failed: Unable to find a trusted npm CLI script/,
    );
    assert.equal(runnerCalls, 0);
  });
});

test("builds the current GUI source before replacing package inputs", () => {
  withFixture(({ guiDir, vscodeGuiDir, intellijWebviewDir }) => {
    const sentinel = "CURRENT_GUI_SOURCE_SENTINEL";
    fs.mkdirSync(path.join(guiDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(guiDir, "src", "sentinel.txt"), sentinel);
    fs.mkdirSync(intellijWebviewDir, { recursive: true });
    fs.writeFileSync(
      path.join(intellijWebviewDir, "index.html"),
      "intellij shell",
    );
    fs.mkdirSync(path.join(vscodeGuiDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(vscodeGuiDir, "assets", "index.js"), "stale");

    let buildCount = 0;
    buildAndCopyGui({
      guiDir,
      vscodeGuiDir,
      intellijWebviewDir,
      runBuild(currentGuiDir) {
        buildCount += 1;
        const distAssets = path.join(currentGuiDir, "dist", "assets");
        fs.mkdirSync(distAssets, { recursive: true });
        fs.writeFileSync(
          path.join(distAssets, "index.js"),
          fs.readFileSync(path.join(currentGuiDir, "src", "sentinel.txt")),
        );
        fs.writeFileSync(path.join(distAssets, "index.css"), "current css");
      },
    });

    assert.equal(buildCount, 1);
    assert.equal(
      fs.readFileSync(path.join(vscodeGuiDir, "assets", "index.js"), "utf8"),
      sentinel,
    );
    assert.equal(
      fs.readFileSync(
        path.join(intellijWebviewDir, "assets", "index.js"),
        "utf8",
      ),
      sentinel,
    );
    assert.equal(
      fs.readFileSync(path.join(intellijWebviewDir, "index.html"), "utf8"),
      "intellij shell",
    );
  });
});

test("fails closed instead of copying an incomplete GUI build", () => {
  withFixture(({ guiDir, vscodeGuiDir, intellijWebviewDir }) => {
    assert.throws(
      () =>
        buildAndCopyGui({
          guiDir,
          vscodeGuiDir,
          intellijWebviewDir,
          runBuild(currentGuiDir) {
            const distAssets = path.join(currentGuiDir, "dist", "assets");
            fs.mkdirSync(distAssets, { recursive: true });
            fs.writeFileSync(path.join(distAssets, "index.js"), "incomplete");
          },
        }),
      /missing required assets/,
    );
    assert.equal(fs.existsSync(vscodeGuiDir), false);
  });
});

function createCurrentBuild(guiDir) {
  const distAssets = path.join(guiDir, "dist", "assets");
  fs.mkdirSync(distAssets, { recursive: true });
  fs.writeFileSync(path.join(distAssets, "index.js"), "current js");
  fs.writeFileSync(path.join(distAssets, "index.css"), "current css");
}

function createOldStaging(vscodeGuiDir, intellijWebviewDir) {
  fs.mkdirSync(path.join(vscodeGuiDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(vscodeGuiDir, "assets", "index.js"), "old vscode");
  fs.writeFileSync(path.join(vscodeGuiDir, "assets", "index.css"), "old css");
  fs.mkdirSync(path.join(intellijWebviewDir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(intellijWebviewDir, "assets", "index.js"),
    "old intellij",
  );
  fs.writeFileSync(
    path.join(intellijWebviewDir, "assets", "index.css"),
    "old css",
  );
  fs.writeFileSync(path.join(intellijWebviewDir, "index.html"), "old shell");
}

function assertOldStaging(vscodeGuiDir, intellijWebviewDir) {
  assert.equal(
    fs.readFileSync(path.join(vscodeGuiDir, "assets", "index.js"), "utf8"),
    "old vscode",
  );
  assert.equal(
    fs.readFileSync(
      path.join(intellijWebviewDir, "assets", "index.js"),
      "utf8",
    ),
    "old intellij",
  );
  assert.equal(
    fs.readFileSync(path.join(intellijWebviewDir, "index.html"), "utf8"),
    "old shell",
  );
}

test("keeps both prior stagings when preparing the second copy fails", () => {
  withFixture(({ guiDir, vscodeGuiDir, intellijWebviewDir }) => {
    createCurrentBuild(guiDir);
    createOldStaging(vscodeGuiDir, intellijWebviewDir);
    let copyCount = 0;
    const failingFs = {
      ...fs,
      cpSync(...args) {
        copyCount += 1;
        if (copyCount === 2) {
          throw new Error("second copy failed");
        }
        return fs.cpSync(...args);
      },
    };

    assert.throws(
      () =>
        buildAndCopyGui({
          guiDir,
          vscodeGuiDir,
          intellijWebviewDir,
          runBuild() {},
          fileSystem: failingFs,
        }),
      /second copy failed/,
    );
    assertOldStaging(vscodeGuiDir, intellijWebviewDir);
  });
});

test("rolls back both stagings when the second replacement rename fails", () => {
  withFixture(({ guiDir, vscodeGuiDir, intellijWebviewDir }) => {
    createCurrentBuild(guiDir);
    createOldStaging(vscodeGuiDir, intellijWebviewDir);
    let renameCount = 0;
    const failingFs = {
      ...fs,
      renameSync(...args) {
        renameCount += 1;
        if (renameCount === 4) {
          throw new Error("second replacement rename failed");
        }
        return fs.renameSync(...args);
      },
    };

    assert.throws(
      () =>
        buildAndCopyGui({
          guiDir,
          vscodeGuiDir,
          intellijWebviewDir,
          runBuild() {},
          fileSystem: failingFs,
        }),
      /second replacement rename failed/,
    );
    assertOldStaging(vscodeGuiDir, intellijWebviewDir);
  });
});

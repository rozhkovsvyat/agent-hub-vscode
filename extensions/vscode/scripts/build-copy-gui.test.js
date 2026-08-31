const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildAndCopyGui } = require("./build-copy-gui");

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

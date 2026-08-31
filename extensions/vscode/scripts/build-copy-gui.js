const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { rimrafSync } = require("rimraf");

const continueDir = path.join(__dirname, "..", "..", "..");

function validateGuiBuild(guiDist) {
  const requiredAssets = [
    path.join(guiDist, "assets", "index.js"),
    path.join(guiDist, "assets", "index.css"),
  ];

  const missingAssets = requiredAssets.filter(
    (asset) => !fs.existsSync(asset) || fs.statSync(asset).size === 0,
  );
  if (missingAssets.length > 0) {
    throw new Error(
      `GUI build is missing required assets:\n${missingAssets.join("\n")}`,
    );
  }
}

function buildGui(guiDir) {
  try {
    execSync("npm run build", {
      cwd: guiDir,
      stdio: "inherit",
    });
  } catch (error) {
    throw new Error(`GUI build failed: ${error.message}`);
  }
}

function replaceDirectoryFrom(source, destination) {
  rimrafSync(destination);
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

/**
 * Rebuild the webview from the checked-out source, verify its required entry
 * assets, and replace every extension copy used by packaging. Keeping this in
 * the normal prepackage path prevents VSIXes from consuming a stale gui/dist.
 */
function buildAndCopyGui({
  guiDir = path.join(continueDir, "gui"),
  vscodeGuiDir = path.join(continueDir, "extensions", "vscode", "gui"),
  intellijWebviewDir = path.join(
    continueDir,
    "extensions",
    "intellij",
    "src",
    "main",
    "resources",
    "webview",
  ),
  runBuild = buildGui,
} = {}) {
  runBuild(guiDir);

  const guiDist = path.join(guiDir, "dist");
  validateGuiBuild(guiDist);

  const intellijIndexPath = path.join(intellijWebviewDir, "index.html");
  const intellijIndex = fs.existsSync(intellijIndexPath)
    ? fs.readFileSync(intellijIndexPath)
    : undefined;

  replaceDirectoryFrom(guiDist, intellijWebviewDir);
  if (intellijIndex) {
    fs.writeFileSync(intellijIndexPath, intellijIndex);
  }

  replaceDirectoryFrom(guiDist, vscodeGuiDir);
}

module.exports = {
  buildAndCopyGui,
  validateGuiBuild,
};

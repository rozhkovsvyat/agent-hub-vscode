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

function removeIfExists(target, fileSystem) {
  if (fileSystem.existsSync(target)) {
    rimrafSync(target);
  }
}

function makeTemporaryDirectory(destination, label, fileSystem) {
  const parent = path.dirname(destination);
  fileSystem.mkdirSync(parent, { recursive: true });
  return fileSystem.mkdtempSync(
    path.join(parent, `.${path.basename(destination)}.${label}-`),
  );
}

/**
 * Replace all package inputs as one recoverable operation. A rename is atomic
 * on a single filesystem; keeping the old directory as a sibling backup lets
 * us restore every destination if any later rename fails.
 */
function replaceDirectoriesTransactionally(
  source,
  destinations,
  fileSystem = fs,
) {
  const replacements = [];
  let rollbackFailed = false;

  try {
    for (const { destination, preserveFile } of destinations) {
      const temporary = makeTemporaryDirectory(
        destination,
        "pending",
        fileSystem,
      );
      const backup = makeTemporaryDirectory(destination, "backup", fileSystem);
      const replacement = {
        destination,
        temporary,
        backup,
        backedUp: false,
        activated: false,
      };
      replacements.push(replacement);
      removeIfExists(backup, fileSystem);

      fileSystem.cpSync(source, temporary, { recursive: true });
      if (preserveFile && fileSystem.existsSync(preserveFile)) {
        const preservedPath = path.join(temporary, path.basename(preserveFile));
        fileSystem.copyFileSync(preserveFile, preservedPath);
      }
      validateGuiBuild(temporary);
    }

    for (const replacement of replacements) {
      if (fileSystem.existsSync(replacement.destination)) {
        fileSystem.renameSync(replacement.destination, replacement.backup);
        replacement.backedUp = true;
      }
      fileSystem.renameSync(replacement.temporary, replacement.destination);
      replacement.activated = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const replacement of [...replacements].reverse()) {
      try {
        if (
          replacement.activated &&
          fileSystem.existsSync(replacement.destination)
        ) {
          removeIfExists(replacement.destination, fileSystem);
        }
        if (replacement.backedUp && fileSystem.existsSync(replacement.backup)) {
          if (fileSystem.existsSync(replacement.destination)) {
            removeIfExists(replacement.destination, fileSystem);
          }
          fileSystem.renameSync(replacement.backup, replacement.destination);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    if (rollbackErrors.length > 0) {
      rollbackFailed = true;
      error.message += `; GUI staging rollback failed and recovery backups were retained: ${rollbackErrors.join("; ")}`;
    }
    throw error;
  } finally {
    for (const replacement of replacements) {
      removeIfExists(replacement.temporary, fileSystem);
      if (!rollbackFailed) {
        removeIfExists(replacement.backup, fileSystem);
      }
    }
  }
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
  fileSystem = fs,
} = {}) {
  runBuild(guiDir);

  const guiDist = path.join(guiDir, "dist");
  validateGuiBuild(guiDist);

  const intellijIndexPath = path.join(intellijWebviewDir, "index.html");
  replaceDirectoriesTransactionally(
    guiDist,
    [
      { destination: intellijWebviewDir, preserveFile: intellijIndexPath },
      { destination: vscodeGuiDir },
    ],
    fileSystem,
  );
}

module.exports = {
  buildAndCopyGui,
  validateGuiBuild,
  replaceDirectoriesTransactionally,
};

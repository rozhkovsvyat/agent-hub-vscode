const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { rimrafSync } = require("rimraf");

const continueDir = path.join(__dirname, "..", "..", "..");
const npmCliExtensions = new Set([".js", ".cjs", ".mjs"]);

function expectedNpmRoots(nodeExecutable, platform) {
  const nodeDirectory = path.dirname(path.resolve(nodeExecutable));
  if (platform === "win32") {
    return [path.join(nodeDirectory, "node_modules", "npm")];
  }

  const prefix = path.dirname(nodeDirectory);
  return [
    path.join(nodeDirectory, "node_modules", "npm"),
    path.join(prefix, "lib", "node_modules", "npm"),
    path.join(prefix, "share", "nodejs", "npm"),
  ];
}

function isPathWithin(filePath, directory) {
  const relative = path.relative(directory, filePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function realExistingNpmCli(candidate, npmRoots, fileSystem) {
  if (
    typeof candidate !== "string" ||
    !npmCliExtensions.has(path.extname(candidate))
  ) {
    return undefined;
  }

  try {
    const cliPath = fileSystem.realpathSync(candidate);
    if (!fileSystem.statSync(cliPath).isFile()) {
      return undefined;
    }
    return npmRoots.some((npmRoot) => {
      try {
        return isPathWithin(cliPath, fileSystem.realpathSync(npmRoot));
      } catch {
        return false;
      }
    })
      ? cliPath
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * npm.cmd cannot reliably be invoked with execFileSync on Windows. Execute the
 * npm CLI script with this Node executable instead, after proving the script
 * belongs to this Node installation rather than trusting npm_execpath.
 */
function resolveNpmCliPath({
  npmExecPath = process.env.npm_execpath,
  nodeExecutable = process.execPath,
  platform = process.platform,
  fileSystem = fs,
  npmRoots = expectedNpmRoots(nodeExecutable, platform),
} = {}) {
  const candidates = [
    npmExecPath,
    ...npmRoots.map((npmRoot) => path.join(npmRoot, "bin", "npm-cli.js")),
  ];
  for (const candidate of candidates) {
    const cliPath = realExistingNpmCli(candidate, npmRoots, fileSystem);
    if (cliPath) {
      return cliPath;
    }
  }

  throw new Error(
    "Unable to find a trusted npm CLI script for the current Node installation",
  );
}

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

function buildGui(
  guiDir,
  {
    runCommand = execFileSync,
    resolveNpmCli = resolveNpmCliPath,
    nodeExecutable = process.execPath,
    platform = process.platform,
    npmExecPath = process.env.npm_execpath,
    fileSystem = fs,
    npmRoots,
  } = {},
) {
  try {
    const npmCliPath = resolveNpmCli({
      npmExecPath,
      nodeExecutable,
      platform,
      fileSystem,
      ...(npmRoots === undefined ? {} : { npmRoots }),
    });
    runCommand(nodeExecutable, [npmCliPath, "run", "build"], {
      cwd: guiDir,
      stdio: "inherit",
      shell: false,
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
  buildOptions,
  fileSystem = fs,
} = {}) {
  runBuild(guiDir, buildOptions);

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
  buildGui,
  expectedNpmRoots,
  resolveNpmCliPath,
  validateGuiBuild,
  replaceDirectoriesTransactionally,
};

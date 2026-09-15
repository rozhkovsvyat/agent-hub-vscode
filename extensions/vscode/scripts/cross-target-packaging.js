/**
 * @file Package the extension for a VS Code target platform other than the
 * build host.
 *
 * `prepackage.js --target` already stages the target's onnxruntime, LanceDB and
 * sqlite3 binaries, so most of cross-building is already solved. Two inputs
 * still come from the host, and both fail quietly rather than loudly:
 *
 *   - `@vscode/ripgrep` resolves its download from `os.platform()` in its own
 *     postinstall, so it can only ever produce the *host* binary. A darwin build
 *     validated against `bin/rg` finds `bin/rg.exe`, or nothing at all when the
 *     install ran with `--ignore-scripts`.
 *   - npm installs `@lancedb/vectordb-<host>` as an optional dependency of
 *     `vectordb`, and prepackage copies the whole `@lancedb` directory into the
 *     staged `out/`. Left alone, a darwin VSIX ships the Windows native module.
 *
 * The LanceDB native package must also match the `vectordb` wrapper exactly -
 * installing it unpinned picks up the current major (0.21.x against a 0.4.20
 * wrapper), which loads and then fails at the ABI boundary on the user's
 * machine. The version is therefore read from the wrapper's own manifest.
 *
 * The voice runtime adds two more host-bound inputs. Both packages support
 * cross-installation through `npm_config_platform` / `npm_config_arch`, but
 * neither is reached that way by a plain `npm install`:
 *
 *   - `ffmpeg-static` resolves its binary name from `os.platform()`, so a
 *     darwin build copies `ffmpeg.exe` - or, after `--ignore-scripts`, nothing.
 *   - `sharp` names its prebuilt after its *own* platform string, where arm64
 *     is spelled `arm64v8`. `sharp-${process.arch}.node` therefore never
 *     matches on an ARM target even when the right binding is present.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { rimrafSync } = require("rimraf");

const RIPGREP_RELEASE = "v13.0.0-10";

/**
 * Mirrors `@vscode/ripgrep@1.15.9` lib/postinstall.js `getTarget()`. That
 * function reads `os.platform()`, so it cannot be reused for another platform;
 * the mapping has to be restated here to cross-build.
 */
const RIPGREP_ASSET_TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

const LANCEDB_PACKAGES = {
  "darwin-arm64": "@lancedb/vectordb-darwin-arm64",
  "darwin-x64": "@lancedb/vectordb-darwin-x64",
  "linux-arm64": "@lancedb/vectordb-linux-arm64-gnu",
  "linux-x64": "@lancedb/vectordb-linux-x64-gnu",
  "win32-arm64": "@lancedb/vectordb-win32-arm64-msvc",
  "win32-x64": "@lancedb/vectordb-win32-x64-msvc",
};

/**
 * Mirrors `sharp@0.32.6` lib/libvips.js `buildPlatformArch()`. sharp spells
 * ARM as `arm64v8`, so the prebuilt is `sharp-darwin-arm64v8.node` while the
 * VS Code target is `darwin-arm64`.
 */
const SHARP_PLATFORM_ARCH = {
  "darwin-arm64": "darwin-arm64v8",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64v8",
  "linux-x64": "linux-x64",
  "win32-arm64": "win32-arm64v8",
  "win32-x64": "win32-x64",
};

const CROSS_TARGETS = Object.keys(RIPGREP_ASSET_TARGETS);

function targetPlatformAndArch(target) {
  const [platform, arch] = String(target).split("-");
  if (!platform || !arch) {
    throw new Error(`Malformed target ${target}`);
  }
  return { platform, arch };
}

function sharpPlatformArch(target) {
  const platformArch = SHARP_PLATFORM_ARCH[target];
  if (!platformArch) {
    throw new Error(`No sharp platform mapping for target ${target}`);
  }
  return platformArch;
}

function sharpBindingName(target) {
  return `sharp-${sharpPlatformArch(target)}.node`;
}

function ffmpegBinaryName(target) {
  return isWindowsTarget(target) ? "ffmpeg.exe" : "ffmpeg";
}

function isWindowsTarget(target) {
  return String(target).startsWith("win");
}

function ripgrepAssetUrl(target) {
  const asset = RIPGREP_ASSET_TARGETS[target];
  if (!asset) {
    throw new Error(`No ripgrep prebuilt mapping for target ${target}`);
  }
  const extension = isWindowsTarget(target) ? ".zip" : ".tar.gz";
  return `https://github.com/microsoft/ripgrep-prebuilt/releases/download/${RIPGREP_RELEASE}/ripgrep-${RIPGREP_RELEASE}-${asset}${extension}`;
}

function ripgrepBinaryName(target) {
  if (!RIPGREP_ASSET_TARGETS[target]) {
    throw new Error(`No ripgrep prebuilt mapping for target ${target}`);
  }
  return isWindowsTarget(target) ? "rg.exe" : "rg";
}

function lancedbPackageName(target) {
  const packageName = LANCEDB_PACKAGES[target];
  if (!packageName) {
    throw new Error(`No LanceDB package mapping for target ${target}`);
  }
  return packageName;
}

function lancedbDirectoryName(target) {
  return lancedbPackageName(target).split("/").pop();
}

/**
 * The native package has to match the wrapper that loads it. Read the pin from
 * `vectordb`'s own optionalDependencies rather than trusting npm's `latest`.
 */
function lancedbVersionForTarget(target, wrapperManifest) {
  const packageName = lancedbPackageName(target);
  const pinned = wrapperManifest?.optionalDependencies?.[packageName];
  if (!pinned) {
    throw new Error(
      `vectordb@${wrapperManifest?.version ?? "?"} does not pin ${packageName}; refusing to install an unversioned native module`,
    );
  }
  return pinned;
}

/**
 * @returns the `@lancedb` directory entries that do not belong to `target`.
 */
function foreignLancedbDirectories(entries, target) {
  const keep = lancedbDirectoryName(target);
  return entries.filter((entry) => entry !== keep);
}

/**
 * @returns the `@vscode/ripgrep/bin` entries that do not belong to `target`.
 */
function foreignRipgrepBinaries(entries, target) {
  const keep = ripgrepBinaryName(target);
  return entries.filter((entry) => entry !== keep);
}

function pruneForeignNativeModules(
  nodeModulesDir,
  target,
  { fileSystem = fs, remove = rimrafSync } = {},
) {
  const removed = [];

  const lancedbDir = path.join(nodeModulesDir, "@lancedb");
  if (fileSystem.existsSync(lancedbDir)) {
    for (const entry of foreignLancedbDirectories(
      fileSystem.readdirSync(lancedbDir),
      target,
    )) {
      remove(path.join(lancedbDir, entry));
      removed.push(path.join("@lancedb", entry));
    }
  }

  const ripgrepBinDir = path.join(nodeModulesDir, "@vscode", "ripgrep", "bin");
  if (fileSystem.existsSync(ripgrepBinDir)) {
    for (const entry of foreignRipgrepBinaries(
      fileSystem.readdirSync(ripgrepBinDir),
      target,
    )) {
      remove(path.join(ripgrepBinDir, entry));
      removed.push(path.join("@vscode", "ripgrep", "bin", entry));
    }
  }

  return removed;
}

async function downloadTo(url, outputPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
}

/**
 * Build a local-only tar invocation for a downloaded ripgrep archive.
 *
 * Windows bsdtar treats an absolute `D:\\...` argv as `host:path` unless
 * `--force-local` is supplied.  Running in the archive directory with a
 * basename is portable across the Windows/macOS/Linux tar implementations
 * used by the release runners and cannot be parsed as a remote path.
 */
function ripgrepExtractionPlan(binDir, archivePath) {
  const resolvedBinDir = path.resolve(binDir);
  const resolvedArchive = path.resolve(archivePath);
  if (path.dirname(resolvedArchive) !== resolvedBinDir) {
    throw new Error(
      `ripgrep archive must be inside its extraction directory: ${resolvedArchive}`,
    );
  }
  return {
    command: "tar",
    args: ["-xf", path.basename(resolvedArchive), "-C", "."],
    cwd: resolvedBinDir,
  };
}

/**
 * Replace `@vscode/ripgrep/bin` with the target platform's prebuilt binary.
 */
async function stageRipgrepForTarget(
  target,
  { extensionDir, download = downloadTo, execute = execFileSync },
) {
  const binDir = path.join(
    extensionDir,
    "node_modules",
    "@vscode",
    "ripgrep",
    "bin",
  );
  rimrafSync(binDir);
  fs.mkdirSync(binDir, { recursive: true });

  const url = ripgrepAssetUrl(target);
  const archive = path.join(
    binDir,
    isWindowsTarget(target) ? "rg.zip" : "rg.tar.gz",
  );
  console.log(`[info] Downloading ripgrep for ${target}: ${url}`);
  await download(url, archive);
  // bsdtar (shipped with Windows) reads both tarballs and zips.
  const extraction = ripgrepExtractionPlan(binDir, archive);
  execute(extraction.command, extraction.args, {
    cwd: extraction.cwd,
    stdio: "inherit",
  });
  fs.unlinkSync(archive);

  const binaryPath = path.join(binDir, ripgrepBinaryName(target));
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`ripgrep binary missing after extraction: ${binaryPath}`);
  }
  if (!isWindowsTarget(target)) {
    fs.chmodSync(binaryPath, 0o755);
  }
  console.log(`[info] Staged ripgrep at ${binaryPath}`);
}

/**
 * Run a package's own installer with npm's cross-install environment.
 *
 * Both `ffmpeg-static` and `sharp` read `npm_config_platform` / `npm_config_arch`
 * instead of `os.platform()` when those are set, which is the documented way to
 * install them for another machine.
 */
function runTargetInstall(scriptPath, target, { cwd, execute = execFileSync }) {
  const { platform, arch } = targetPlatformAndArch(target);
  execute(process.execPath, [scriptPath], {
    cwd,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      // eslint-disable-next-line @typescript-eslint/naming-convention
      npm_config_platform: platform,
      // eslint-disable-next-line @typescript-eslint/naming-convention
      npm_config_arch: arch,
    },
  });
}

/**
 * Download the target's ffmpeg binary into `ffmpeg-static`.
 *
 * `install.js` exits early when the binary already exists, and darwin-arm64 and
 * darwin-x64 share the file name `ffmpeg` - so a stale binary from the previous
 * target would silently ship. Clear both names first.
 */
function stageFfmpegForTarget(
  target,
  { extensionDir, execute = execFileSync },
) {
  const packageDir = path.join(extensionDir, "node_modules", "ffmpeg-static");
  for (const name of ["ffmpeg", "ffmpeg.exe"]) {
    rimrafSync(path.join(packageDir, name));
  }
  runTargetInstall(path.join(packageDir, "install.js"), target, {
    cwd: packageDir,
    execute,
  });
  const binaryPath = path.join(packageDir, ffmpegBinaryName(target));
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`ffmpeg binary missing after install: ${binaryPath}`);
  }
  return binaryPath;
}

/**
 * Download the target's sharp prebuilt and its vendored libvips.
 *
 * The previous target's binding and vendor tree are removed first: sharp loads
 * whatever matches its own platform string at runtime, so leftovers are shipped
 * without ever failing the build.
 */
function stageSharpForTarget(target, { extensionDir, execute = execFileSync }) {
  const packageDir = path.join(extensionDir, "node_modules", "sharp");
  rimrafSync(path.join(packageDir, "build", "Release"));
  rimrafSync(path.join(packageDir, "vendor"));

  runTargetInstall(path.join(packageDir, "install", "libvips.js"), target, {
    cwd: packageDir,
    execute,
  });
  runTargetInstall(
    path.join(extensionDir, "node_modules", "prebuild-install", "bin.js"),
    target,
    { cwd: packageDir, execute },
  );
  if (isWindowsTarget(target)) {
    runTargetInstall(path.join(packageDir, "install", "dll-copy.js"), target, {
      cwd: packageDir,
      execute,
    });
  }

  const bindingPath = path.join(
    packageDir,
    "build",
    "Release",
    sharpBindingName(target),
  );
  if (!fs.existsSync(bindingPath)) {
    throw new Error(`sharp binding missing after install: ${bindingPath}`);
  }
  return bindingPath;
}

function readWrapperManifest(extensionDir) {
  const manifestPath = path.join(
    extensionDir,
    "node_modules",
    "vectordb",
    "package.json",
  );
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

module.exports = {
  CROSS_TARGETS,
  LANCEDB_PACKAGES,
  RIPGREP_ASSET_TARGETS,
  RIPGREP_RELEASE,
  SHARP_PLATFORM_ARCH,
  ffmpegBinaryName,
  foreignLancedbDirectories,
  foreignRipgrepBinaries,
  lancedbDirectoryName,
  lancedbPackageName,
  lancedbVersionForTarget,
  pruneForeignNativeModules,
  readWrapperManifest,
  ripgrepAssetUrl,
  ripgrepBinaryName,
  ripgrepExtractionPlan,
  sharpBindingName,
  sharpPlatformArch,
  stageFfmpegForTarget,
  stageRipgrepForTarget,
  stageSharpForTarget,
  targetPlatformAndArch,
};

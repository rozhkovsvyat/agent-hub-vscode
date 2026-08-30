import fs from "node:fs";
import path from "node:path";

/**
 * Cukii bridge IPC/transcripts/logs are machine-local scratch artefacts.
 * They must never land in a vault, the repository, or the shared OS temp
 * directory where they become visible as unrelated timeline receipts.
 */
export const CUKII_BRIDGE_SCRATCH_ROOT = "D:\\Scratch\\cukii-bridge";
export const CUKII_PERMISSION_SCRATCH_ROOT = "D:\\Scratch\\cukii-permission";
export const CUKII_VOICE_SCRATCH_ROOT = "D:\\Scratch\\cukii-voice";

/**
 * Make a fixed Scratch directory one component at a time. Every existing
 * component is lstat'd: a Windows junction/reparse point is rejected instead
 * of followed. The production root is a constant, never a caller argument.
 */
export function createDirectoryWithoutReparse(root: string): string {
  const absolute = path.resolve(root);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(/[\\/]+/)) {
    if (!segment) continue;
    current = path.join(current, segment);
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Unsafe bridge Scratch path component: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current);
      const created = fs.lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`Unsafe bridge Scratch path component: ${current}`);
      }
    }
  }
  return fs.realpathSync.native(absolute);
}

export function bridgeScratchRoot(): string {
  return createDirectoryWithoutReparse(CUKII_BRIDGE_SCRATCH_ROOT);
}

export function permissionScratchRoot(): string {
  return createDirectoryWithoutReparse(CUKII_PERMISSION_SCRATCH_ROOT);
}

export function voiceScratchRoot(): string {
  return createDirectoryWithoutReparse(CUKII_VOICE_SCRATCH_ROOT);
}

function isDirectChild(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/**
 * Creates an owned, non-reparse child under one of Cukii's fixed Scratch
 * roots. Callers never supply a production root, so vault/%TEMP% escapes are
 * rejected before an artefact is created.
 */
export function createCukiiScratchDirectory(
  root: string,
  prefix: string,
): string {
  const canonicalRoot = createDirectoryWithoutReparse(root);
  const directory = fs.mkdtempSync(path.join(canonicalRoot, `${prefix}-`));
  const stats = fs.lstatSync(directory);
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    !isDirectChild(path.resolve(directory), canonicalRoot)
  ) {
    throw new Error(`Unsafe Cukii Scratch directory: ${directory}`);
  }
  return directory;
}

/** Remove only an owned direct child after rejecting reparse/path escapes. */
export function removeCukiiScratchDirectory(
  directory: string,
  root: string,
): void {
  const canonicalRoot = createDirectoryWithoutReparse(root);
  const resolved = path.resolve(directory);
  if (!isDirectChild(resolved, canonicalRoot)) {
    throw new Error(`Refusing to remove outside Cukii Scratch: ${directory}`);
  }
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Unsafe Cukii Scratch directory: ${directory}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

/** A prompt file is created exclusively, so an attacker cannot pre-place it. */
export function writeBridgeScratchFile(
  prefix: string,
  content: string,
  extension: ".txt" | ".log" = ".txt",
): string {
  const file = createBridgeScratchPath(prefix, extension);
  fs.writeFileSync(file, content, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return file;
}

export function removeBridgeScratchFile(file: string): void {
  const root = bridgeScratchRoot();
  const resolved = path.resolve(file);
  if (!isDirectChild(resolved, root)) {
    throw new Error(`Refusing to remove outside Cukii Scratch: ${file}`);
  }
  try {
    const stats = fs.lstatSync(resolved);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Unsafe Cukii Scratch file: ${file}`);
    }
    fs.rmSync(resolved, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function createBridgeScratchPath(
  prefix: string,
  extension: ".txt" | ".log" = ".txt",
): string {
  const safePrefix = prefix.replace(/[^a-z0-9._-]/gi, "-");
  return path.join(
    bridgeScratchRoot(),
    `${safePrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`,
  );
}

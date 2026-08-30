import fs from "node:fs";
import path from "node:path";

/**
 * Cukii bridge IPC/transcripts/logs are machine-local scratch artefacts.
 * They must never land in a vault, the repository, or the shared OS temp
 * directory where they become visible as unrelated timeline receipts.
 */
export const CUKII_BRIDGE_SCRATCH_ROOT = "D:\\Scratch\\cukii-bridge";

function windowsPathKey(candidate: string): string {
  return path.resolve(candidate).replaceAll("/", "\\").toLowerCase();
}

function isWithin(child: string, root: string): boolean {
  const childKey = windowsPathKey(child);
  const rootKey = windowsPathKey(root).replace(/\\+$/, "");
  return childKey === rootKey || childKey.startsWith(`${rootKey}\\`);
}

/**
 * Make a fixed Scratch directory one component at a time. Every existing
 * component is lstat'd: a Windows junction/reparse point is rejected instead
 * of followed. The production root is a constant, never a caller argument.
 */
function createDirectoryWithoutReparse(root: string): string {
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

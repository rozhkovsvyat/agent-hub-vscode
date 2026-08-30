import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Cukii bridge IPC/transcripts/logs are machine-local scratch artefacts.
 * They must never land in a vault, the repository, or the shared OS temp
 * directory where they become visible as unrelated timeline receipts.
 */
export const CUKII_BRIDGE_SCRATCH_ROOT = "D:\\Scratch\\cukii-bridge";
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{16,96}$/;

export type OwnedBridgeScratchFile = {
  path: string;
  cleanup: () => void;
};

let raceHook:
  | ((phase: "after-create" | "before-cleanup", path: string) => void)
  | undefined;

/** Test-only deterministic race injection; production has no configurable path. */
export function setBridgeScratchRaceHookForTest(hook: typeof raceHook): void {
  raceHook = hook;
}

function windowsPathKey(candidate: string): string {
  return path.resolve(candidate).replaceAll("/", "\\").toLowerCase();
}

function isWithin(child: string, root: string): boolean {
  const childKey = windowsPathKey(child);
  const rootKey = windowsPathKey(root).replace(/\\+$/, "");
  return childKey === rootKey || childKey.startsWith(`${rootKey}\\`);
}

function assertOpaqueToken(token: string): void {
  if (!OPAQUE_TOKEN.test(token)) {
    throw new Error("Bridge Scratch token must be an opaque safe token.");
  }
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

function lstatOwnedFile(
  filePath: string,
  root: string,
  expected: { dev: number; ino: number },
): boolean {
  try {
    const canonicalRoot = createDirectoryWithoutReparse(root);
    const lexicalPath = path.resolve(filePath);
    if (!isWithin(lexicalPath, canonicalRoot)) return false;
    const entry = fs.lstatSync(lexicalPath);
    if (entry.isSymbolicLink() || !entry.isFile()) return false;
    const canonicalFile = fs.realpathSync.native(lexicalPath);
    if (!isWithin(canonicalFile, canonicalRoot)) return false;
    const stats = fs.statSync(canonicalFile);
    return stats.dev === expected.dev && stats.ino === expected.ino;
  } catch {
    return false;
  }
}

export function createKimiPromptScratchFile(
  prompt: string,
): OwnedBridgeScratchFile {
  const canonicalRoot = createDirectoryWithoutReparse(
    CUKII_BRIDGE_SCRATCH_ROOT,
  );
  const token = randomBytes(24).toString("base64url");
  assertOpaqueToken(token);
  const ownerDirectory = path.join(canonicalRoot, `owner-${token}`);
  fs.mkdirSync(ownerDirectory, { mode: 0o700 });
  const ownerStats = fs.lstatSync(ownerDirectory);
  if (ownerStats.isSymbolicLink() || !ownerStats.isDirectory()) {
    throw new Error("Unsafe owned Kimi Scratch directory.");
  }
  const canonicalOwnerDirectory = fs.realpathSync.native(ownerDirectory);
  if (!isWithin(canonicalOwnerDirectory, canonicalRoot)) {
    throw new Error("Kimi Scratch directory escaped its root.");
  }
  const filePath = path.join(
    canonicalOwnerDirectory,
    `kimi-prompt-${token}.txt`,
  );
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  let expected: { dev: number; ino: number };
  try {
    const stats = fs.fstatSync(descriptor);
    expected = { dev: stats.dev, ino: stats.ino };
    fs.writeFileSync(descriptor, prompt, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  if (!lstatOwnedFile(filePath, canonicalOwnerDirectory, expected)) {
    throw new Error("Kimi Scratch file failed ownership validation.");
  }
  raceHook?.("after-create", filePath);

  return {
    path: filePath,
    cleanup(): void {
      raceHook?.("before-cleanup", filePath);
      if (!lstatOwnedFile(filePath, canonicalOwnerDirectory, expected)) {
        console.warn(
          `[Cukii] refusing to unlink unowned Kimi Scratch file: ${filePath}`,
        );
        return;
      }
      try {
        fs.unlinkSync(filePath);
        fs.rmdirSync(canonicalOwnerDirectory);
      } catch {
        console.warn(
          `[Cukii] Kimi Scratch cleanup left owned artifact: ${filePath}`,
        );
      }
    },
  };
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

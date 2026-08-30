import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Cukii bridge IPC/transcripts/logs are machine-local scratch artefacts.
 * They must never land in a vault, the repository, or the shared OS temp
 * directory where they become visible as unrelated timeline receipts.
 */
export const CUKII_BRIDGE_SCRATCH_ROOT = "D:\\Scratch\\cukii-bridge";
export const CUKII_STEER_SCRATCH_ROOT = "D:\\Scratch\\cukii-steer";
/** An isolated fixed root used only by the extension contract tests. */
export const CUKII_STEER_TEST_SCRATCH_ROOT =
  "D:\\Scratch\\cukii-steer-test-only";

const OPAQUE_NONCE = /^[A-Za-z0-9_-]{16,96}$/;

export type OwnedSteerScratchFile = {
  path: string;
  append: (text: string) => boolean;
  cleanup: () => void;
};

function windowsPathKey(candidate: string): string {
  return path.resolve(candidate).replaceAll("/", "\\").toLowerCase();
}

function isWithin(child: string, root: string): boolean {
  const childKey = windowsPathKey(child);
  const rootKey = windowsPathKey(root).replace(/\\+$/, "");
  return childKey === rootKey || childKey.startsWith(`${rootKey}\\`);
}

function assertOpaqueNonce(nonce: string): void {
  if (!OPAQUE_NONCE.test(nonce)) {
    throw new Error("Bridge steering nonce must be an opaque safe token.");
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

function createOwnedSteerScratchFile(
  root: string,
  nonce = randomBytes(24).toString("base64url"),
): OwnedSteerScratchFile {
  assertOpaqueNonce(nonce);
  const canonicalRoot = createDirectoryWithoutReparse(root);
  const filePath = path.join(canonicalRoot, `cukii-steer-${nonce}.txt`);
  if (!isWithin(filePath, canonicalRoot)) {
    throw new Error("Bridge steering file escaped its Scratch root.");
  }

  // wx refuses an attacker-provided pre-existing file. Validate the descriptor
  // afterwards so a race cannot turn append/cleanup into an operation on a
  // replacement object.
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  let expected: { dev: number; ino: number };
  try {
    const stats = fs.fstatSync(descriptor);
    expected = { dev: stats.dev, ino: stats.ino };
  } finally {
    fs.closeSync(descriptor);
  }
  if (!lstatOwnedFile(filePath, canonicalRoot, expected)) {
    throw new Error("Bridge steering file failed ownership validation.");
  }

  return {
    path: filePath,
    append(text: string): boolean {
      if (!lstatOwnedFile(filePath, canonicalRoot, expected)) return false;
      let handle: number | undefined;
      try {
        // Opening before writing and comparing fstat identity prevents a
        // substituted symlink/reparse target from receiving user content.
        handle = fs.openSync(filePath, "a");
        const stats = fs.fstatSync(handle);
        if (stats.dev !== expected.dev || stats.ino !== expected.ino) {
          return false;
        }
        fs.writeFileSync(handle, text, "utf8");
        return true;
      } catch {
        return false;
      } finally {
        if (handle !== undefined) fs.closeSync(handle);
      }
    },
    cleanup(): void {
      if (!lstatOwnedFile(filePath, canonicalRoot, expected)) return;
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Idempotent on normal completion, error and cancellation. A failed
        // validation intentionally leaves a suspicious path untouched.
      }
    },
  };
}

export function createProductionSteerScratchFile(): OwnedSteerScratchFile {
  return createOwnedSteerScratchFile(CUKII_STEER_SCRATCH_ROOT);
}

/** Test-only fixed-root hook; it deliberately cannot select a production root. */
export function createTestSteerScratchFile(
  nonce: string,
): OwnedSteerScratchFile {
  return createOwnedSteerScratchFile(CUKII_STEER_TEST_SCRATCH_ROOT, nonce);
}

export function bridgeScratchRoot(): string {
  const root = path.resolve(CUKII_BRIDGE_SCRATCH_ROOT);
  fs.mkdirSync(root, { recursive: true });
  return root;
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

export function steerScratchRoot(): string {
  return createDirectoryWithoutReparse(CUKII_STEER_SCRATCH_ROOT);
}

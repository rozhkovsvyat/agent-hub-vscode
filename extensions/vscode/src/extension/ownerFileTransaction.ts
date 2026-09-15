import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

type OwnerFileLockOptions = {
  now?: () => number;
  processAlive?: (pid: number) => boolean;
  timeoutMs?: number;
};

function pause(milliseconds: number): void {
  Atomics.wait(waitCell, 0, 0, milliseconds);
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another security context.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockOwnerPid(token: string): number | undefined {
  const match = token.match(/^(\d+):\d+:[a-f0-9]{32}$/);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Serialize Cukii read-modify-write transactions on an owner-controlled file.
 * The lock is advisory for Cukii processes, exclusive on NTFS/POSIX, and has a
 * bounded stale recovery path for an Extension Host that died mid-update.
 */
export function withOwnerFileLock<T>(
  target: string,
  action: () => T,
  options: OwnerFileLockOptions = {},
): T {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const lockPath = `${target}.cukii.lock`;
  const now = options.now ?? Date.now;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const token = `${process.pid}:${now()}:${randomBytes(16).toString("hex")}`;
  const deadline = now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  let descriptor: number | undefined;

  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, token, { encoding: "utf8" });
      fs.fsyncSync(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const ageMs = now() - fs.statSync(lockPath).mtimeMs;
        const ownerPid = lockOwnerPid(fs.readFileSync(lockPath, "utf8"));
        if (
          ageMs > LOCK_STALE_MS &&
          ownerPid !== undefined &&
          !processAlive(ownerPid)
        ) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (now() >= deadline) {
        throw new Error(`timed out waiting for Cukii owner-file lock: ${target}`);
      }
      pause(LOCK_WAIT_MS);
    }
  }

  try {
    return action();
  } finally {
    fs.closeSync(descriptor);
    try {
      if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
    } catch {
      // A crashed/stale owner may already have removed the lock.
    }
  }
}

/** Publish one complete owner file without a shared temporary pathname. */
export function writeOwnerFileAtomic(target: string, body: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, body, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // Windows ACLs are authoritative; POSIX configs are owner-only.
    }
    fs.renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // The complete file was either published or remains as a unique orphan.
    }
  }
}

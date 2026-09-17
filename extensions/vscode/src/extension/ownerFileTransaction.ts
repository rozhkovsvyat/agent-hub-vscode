import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
/**
 * When a lock is older than this, its owner is gone whatever the pid says.
 *
 * 🔴 The liveness check alone can never clear a lock whose pid was reused by an
 * unrelated process: `processAlive` keeps answering yes forever, so every later
 * transaction on that file waits out the full timeout. The critical section is
 * a read, a merge and one atomic write — nothing legitimate holds it for
 * minutes, so age is the safer authority once it gets this large.
 */
const LOCK_ABANDON_MS = 10 * 60_000;
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
      const opened = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(opened, token, { encoding: "utf8" });
        fs.fsyncSync(opened);
      } catch (error) {
        fs.closeSync(opened);
        throw error;
      }
      descriptor = opened;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const ageMs = now() - fs.statSync(lockPath).mtimeMs;
        const ownerPid = lockOwnerPid(fs.readFileSync(lockPath, "utf8"));
        const dead =
          ageMs > LOCK_STALE_MS &&
          ownerPid !== undefined &&
          !processAlive(ownerPid);
        if (dead || ageMs > LOCK_ABANDON_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (now() >= deadline) {
        // Name the lock, not just the file: this message is the only thing an
        // owner has to act on when a transaction cannot get through.
        throw new Error(
          `timed out waiting for Cukii owner-file lock ${lockPath}; delete it if no editor window is updating ${path.basename(target)}`,
        );
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

/**
 * Write through a symlink instead of replacing it.
 *
 * 🔴 `renameSync` publishes over the link itself. An owner who points
 * `~/.claude/CLAUDE.md` at the file in their vault would get the link silently
 * swapped for a plain copy, the real contract left without the block, and a
 * report that says `written`. Resolving first also keeps two paths that name
 * one file behind one lock.
 */
export function resolveOwnerFile(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    // Missing file, or a path we may not resolve: write where we were told.
    return target;
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

import { spawn } from "node:child_process";

type BridgeChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number;
  once(event: "close", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
};

export type TerminationOptions = {
  graceMs?: number;
  forceMs?: number;
  forceKill?: (
    child: BridgeChild,
  ) => boolean | void | Promise<boolean | void>;
  /** Test-only platform override so Windows ordering can be asserted on any host. */
  platform?: NodeJS.Platform;
};

function wait(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

function remainingBudget(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function hasExited(child: BridgeChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForClose(
  closed: Promise<void>,
  child: BridgeChild,
  budgetMs: number,
): Promise<boolean> {
  if (hasExited(child)) return true;
  const outcome = await Promise.race([
    closed.then(() => "closed" as const),
    wait(budgetMs),
  ]);
  return outcome === "closed" || hasExited(child);
}

async function defaultForceKill(
  child: BridgeChild,
  budgetMs: number,
): Promise<boolean> {
  // Capture PID before any await: a recycled PID must not be killed later.
  const pid = child.pid;
  if (process.platform === "win32" && pid) {
    if (hasExited(child)) return true;
    const killer = spawn(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", String(pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        killer.kill();
        resolve(false);
      }, budgetMs);
      killer.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      killer.once("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }
  return child.kill("SIGKILL");
}

/**
 * Terminate a native-bridge child.
 *
 * @returns `true` when the child is verified exited (including already-exited);
 *   `false` when the force budget elapses without a close — never a silent success.
 */
export async function terminateBridgeChild(
  child: BridgeChild,
  options: TerminationOptions = {},
): Promise<boolean> {
  if (hasExited(child)) return true;

  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? 750;
  const forceMs =
    options.forceMs ?? (platform === "win32" ? 10_000 : 1_250);
  const forceKill =
    options.forceKill ??
    ((candidate: BridgeChild) => defaultForceKill(candidate, forceMs));

  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );

  // Windows bridges are often cmd.exe → node → node. Soft-killing the root
  // first orphans descendants; taskkill /T against a dead PID then no-ops.
  // Tree-kill while the root PID still exists; never root-only kill first.
  if (platform === "win32") {
    if (hasExited(child)) return true;
    const deadline = Date.now() + forceMs;
    await forceKill(child);
    return waitForClose(closed, child, remainingBudget(deadline));
  }

  child.kill();
  if (await waitForClose(closed, child, graceMs)) {
    return true;
  }

  if (hasExited(child)) return true;

  const deadline = Date.now() + forceMs;
  await forceKill(child);
  return waitForClose(closed, child, remainingBudget(deadline));
}

function windowsTasklistHasPid(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(
      "C:\\Windows\\System32\\tasklist.exe",
      ["/FI", `PID eq ${pid}`, "/NH"],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let stdout = "";
    const timer = setTimeout(() => {
      probe.kill();
      resolve(false);
    }, 2_000);
    probe.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    probe.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    probe.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && stdout.includes(String(pid)));
    });
  });
}

/**
 * Liveness probe for a bridge pid. Windows asks tasklist; POSIX uses
 * signal 0. A probe failure is reported as "dead" so callers never block
 * recovery on a probe that cannot answer.
 */
export async function isBridgePidAlive(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    return windowsTasklistHasPid(pid);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means a live process we are not allowed to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The exact command an operator can run to reap an orphaned bridge tree. */
export function manualTreeKillCommand(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? `taskkill /PID ${pid} /T /F` : `kill -9 ${pid}`;
}

function windowsTaskKillTree(pid: number, budgetMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const killer = spawn(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", String(pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    const timer = setTimeout(
      () => {
        killer.kill();
        resolve(false);
      },
      Math.max(1, budgetMs),
    );
    killer.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    killer.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function posixForceTreeKill(pid: number): Promise<boolean> {
  // A detached bridge would own a process group keyed by its pid; otherwise
  // the group kill misses and the direct SIGKILL is the fallback.
  try {
    process.kill(-pid, "SIGKILL");
    return Promise.resolve(true);
  } catch {
    try {
      process.kill(pid, "SIGKILL");
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }
}

export type BridgeTreeKillRetryOptions = {
  budgetMs?: number;
  platform?: NodeJS.Platform;
  /** One forced tree kill; its own verdict is advisory. Only the pid
   * liveness verification afterwards decides the result. */
  forceTreeKill?: (pid: number, budgetMs: number) => Promise<boolean>;
  pidAlive?: (pid: number) => boolean | Promise<boolean>;
};

/**
 * Last-resort teardown for a bridge tree whose primary cancellation could not
 * verify death. Performs exactly one forced tree kill within the budget and
 * verifies the pid afterwards; resolves true only on verified death.
 */
export async function retryBridgeTreeKill(
  pid: number,
  options: BridgeTreeKillRetryOptions = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const budgetMs = options.budgetMs ?? 5_000;
  const pidAlive = options.pidAlive ?? (() => isBridgePidAlive(pid));
  if (!(await pidAlive(pid))) return true;

  const deadline = Date.now() + budgetMs;
  const force =
    options.forceTreeKill ??
    ((forcePid: number, forceBudgetMs: number) =>
      platform === "win32"
        ? windowsTaskKillTree(forcePid, forceBudgetMs)
        : posixForceTreeKill(forcePid));
  await force(pid, remainingBudget(deadline));

  // A just-killed pid may take a moment to disappear from the OS tables.
  while (true) {
    if (!(await pidAlive(pid))) return true;
    if (Date.now() >= deadline) return false;
    await wait(Math.min(50, remainingBudget(deadline)));
  }
}

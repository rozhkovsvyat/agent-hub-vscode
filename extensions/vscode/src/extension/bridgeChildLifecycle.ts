import { spawn } from "node:child_process";

type BridgeChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number;
  once(event: "close", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
};

type WindowsProcessRow = { pid: number; parentPid: number };

export type TerminationOptions = {
  graceMs?: number;
  forceMs?: number;
  forceKill?: (child: BridgeChild) => boolean | void | Promise<boolean | void>;
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

/** Parent-filtered CIM query. A full Win32_Process dump times out under load
 * and then Stop cannot reap descendants of an already-exited launcher. */
function windowsDirectChildren(
  parentPid: number,
  budgetMs: number,
): Promise<WindowsProcessRow[] | undefined> {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    const script =
      "$ErrorActionPreference='Stop'; " +
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | ` +
      "ForEach-Object { '{0},{1}' -f $_.ProcessId,$_.ParentProcessId }";
    const probe = spawn(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let stdout = "";
    let settled = false;
    const finish = (rows: WindowsProcessRow[] | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(rows);
    };
    const timer = setTimeout(
      () => {
        probe.kill();
        finish(undefined);
      },
      Math.max(1, budgetMs),
    );
    probe.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    probe.once("error", () => finish(undefined));
    probe.once("close", (code) => {
      if (code !== 0) return finish(undefined);
      const rows = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [pid, parentPid] = line.split(",").map(Number);
          return { pid, parentPid };
        })
        .filter(
          (row) =>
            Number.isSafeInteger(row.pid) &&
            row.pid > 0 &&
            Number.isSafeInteger(row.parentPid) &&
            row.parentPid >= 0,
        );
      finish(rows);
    });
  });
}

async function windowsDescendantRows(
  rootPid: number,
  budgetMs: number,
): Promise<WindowsProcessRow[] | undefined> {
  const deadline = Date.now() + budgetMs;
  const descendants: WindowsProcessRow[] = [];
  let frontier = [rootPid];
  const seen = new Set<number>(frontier);
  while (frontier.length > 0) {
    if (remainingBudget(deadline) <= 0) return undefined;
    // Probe one tree level in parallel: each CIM query spawns PowerShell
    // (~0.5 s), so a sequential walk over a wide tree exceeded the shared
    // budget and orphans of an exited launcher survived Stop.
    const levels = await Promise.all(
      frontier.map((parent) =>
        windowsDirectChildren(parent, remainingBudget(deadline)),
      ),
    );
    if (levels.some((children) => children === undefined)) return undefined;
    const next: number[] = [];
    for (const children of levels) {
      for (const child of children!) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        descendants.push(child);
        next.push(child.pid);
      }
    }
    frontier = next;
  }
  return descendants;
}

async function windowsTreeIsAlive(
  rootPid: number,
  budgetMs = 2_000,
): Promise<boolean> {
  if (await windowsTasklistHasPid(rootPid)) return true;
  const descendants = await windowsDescendantRows(rootPid, budgetMs);
  // An unavailable process table is unknown, not proof of death.
  return descendants === undefined || descendants.length > 0;
}

function posixGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForTreeExit(
  pid: number,
  platform: NodeJS.Platform,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (true) {
    const alive =
      platform === "win32"
        ? await windowsTreeIsAlive(
            pid,
            Math.min(6_000, remainingBudget(deadline)),
          )
        : posixGroupIsAlive(pid);
    if (!alive) return true;
    if (Date.now() >= deadline) return false;
    await wait(Math.min(50, remainingBudget(deadline)));
  }
}

async function waitForWindowsPidsExit(
  pids: number[],
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (true) {
    let anyAlive = false;
    for (const pid of pids) {
      if (await windowsTasklistHasPid(pid)) {
        anyAlive = true;
        break;
      }
    }
    if (!anyAlive) return true;
    if (Date.now() >= deadline) return false;
    await wait(Math.min(50, remainingBudget(deadline)));
  }
}

async function windowsKillDescendantsAfterRootExit(
  rootPid: number,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  const descendants = await windowsDescendantRows(
    rootPid,
    Math.min(6_000, remainingBudget(deadline)),
  );
  if (descendants === undefined) return false;
  if (descendants.length === 0) return true;
  const descendantIds = new Set(descendants.map((row) => row.pid));
  const topLevel = descendants.filter(
    (row) => !descendantIds.has(row.parentPid),
  );
  for (const row of topLevel) {
    if (remainingBudget(deadline) <= 0) return false;
    await windowsTaskKillTree(row.pid, remainingBudget(deadline));
  }
  // Verify the exact snapshot. Once an intermediate parent disappears, a
  // fresh parent-chain walk can no longer reach a surviving grandchild.
  return waitForWindowsPidsExit(
    descendants.map((row) => row.pid),
    remainingBudget(deadline),
  );
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
  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? 750;
  const forceMs = options.forceMs ?? (platform === "win32" ? 10_000 : 1_250);
  const forceKill =
    options.forceKill ??
    ((candidate: BridgeChild) => defaultForceKill(candidate, forceMs));

  if (hasExited(child)) {
    if (
      platform === "win32" &&
      process.platform === "win32" &&
      child.pid &&
      !options.forceKill
    ) {
      return windowsKillDescendantsAfterRootExit(child.pid, forceMs);
    }
    if (
      platform !== "win32" &&
      process.platform === platform &&
      child.pid &&
      !options.forceKill
    ) {
      if (!posixGroupIsAlive(child.pid)) return true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Verification below is authoritative.
      }
      return waitForTreeExit(child.pid, platform, forceMs);
    }
    return true;
  }

  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );

  // Windows bridges are often cmd.exe → node → node. Soft-killing the root
  // first orphans descendants; taskkill /T against a dead PID then no-ops.
  // Tree-kill while the root PID still exists; never root-only kill first.
  if (platform === "win32") {
    if (hasExited(child)) return true;
    const deadline = Date.now() + forceMs;
    const descendants =
      !options.forceKill && child.pid && process.platform === "win32"
        ? await windowsDescendantRows(
            child.pid,
            Math.min(6_000, remainingBudget(deadline)),
          )
        : undefined;
    const knownPids =
      descendants && child.pid
        ? [child.pid, ...descendants.map((row) => row.pid)]
        : child.pid
          ? [child.pid]
          : [];
    await forceKill(child);
    const rootClosed = await waitForClose(
      closed,
      child,
      remainingBudget(deadline),
    );
    if (!rootClosed) return false;
    if (options.forceKill || !child.pid || process.platform !== "win32") {
      return true;
    }
    return waitForWindowsPidsExit(knownPids, remainingBudget(deadline));
  }

  if (child.pid && process.platform === platform && !options.forceKill) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The group may already be gone; the liveness check decides.
    }
    if (await waitForTreeExit(child.pid, platform, graceMs)) return true;
    const deadline = Date.now() + forceMs;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group may have exited between probe and signal.
    }
    return waitForTreeExit(child.pid, platform, remainingBudget(deadline));
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

export function tasklistProbeIndicatesAlive(
  code: number | null,
  stdout: string,
  pid: number,
): boolean {
  return code !== 0 || stdout.includes(String(pid));
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
      // Unknown is fail-closed: callers may not free a run slot merely because
      // the OS probe timed out under load.
      resolve(true);
    }, 2_000);
    probe.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    probe.once("error", () => {
      clearTimeout(timer);
      resolve(true);
    });
    probe.once("close", (code) => {
      clearTimeout(timer);
      // A failed tasklist invocation is unknown, never proof that a process
      // died. Callers use true as the fail-closed "possibly alive" result.
      resolve(tasklistProbeIndicatesAlive(code, stdout, pid));
    });
  });
}

/**
 * Liveness probe for a bridge pid. Windows asks tasklist; POSIX uses
 * signal 0. A probe failure is treated as unknown/alive so callers never issue
 * a successful termination receipt without proof of death.
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

/** Liveness of the owned native process tree, not merely its launcher PID. */
export async function isBridgeProcessTreeAlive(pid: number): Promise<boolean> {
  return process.platform === "win32"
    ? windowsTreeIsAlive(pid)
    : posixGroupIsAlive(pid);
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
  const pidAlive = options.pidAlive ?? (() => isBridgeProcessTreeAlive(pid));
  if (!(await pidAlive(pid))) return true;

  const deadline = Date.now() + budgetMs;
  const force =
    options.forceTreeKill ??
    ((forcePid: number, forceBudgetMs: number) =>
      platform === "win32"
        ? windowsTaskKillTree(forcePid, forceBudgetMs)
        : posixForceTreeKill(forcePid));
  if (
    platform === "win32" &&
    process.platform === "win32" &&
    !(await isBridgePidAlive(pid)) &&
    !options.forceTreeKill
  ) {
    return windowsKillDescendantsAfterRootExit(pid, remainingBudget(deadline));
  }
  await force(pid, remainingBudget(deadline));

  // A just-killed pid may take a moment to disappear from the OS tables.
  while (true) {
    if (!(await pidAlive(pid))) return true;
    if (Date.now() >= deadline) return false;
    await wait(Math.min(50, remainingBudget(deadline)));
  }
}

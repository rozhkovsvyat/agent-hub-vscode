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

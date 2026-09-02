import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  isBridgePidAlive,
  retryBridgeTreeKill,
  terminateBridgeChild,
} from "./bridgeChildLifecycle";

class UncooperativeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 1234;
  kill = vi.fn(() => true);
}

class ExitedChild extends EventEmitter {
  exitCode: number | null = 0;
  signalCode: NodeJS.Signals | null = null;
  pid = 5678;
  kill = vi.fn(() => true);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid) return;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

type TreePids = {
  parentPid: number;
  grandchildPid: number;
};

async function readTreePids(child: ChildProcess): Promise<TreePids> {
  let buffer = "";
  let stderr = "";
  return new Promise<TreePids>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`grandchild pid not reported; stdout=${buffer}`));
    }, 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = /^(\{[^\r\n]+\})\r?\n/.exec(buffer);
      if (!match) return;
      clearTimeout(timer);
      resolve(JSON.parse(match[1]) as TreePids);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `root exited before pid (${code}); stdout=${buffer}; stderr=${stderr}`,
        ),
      );
    });
  });
}

/** cmd.exe → node parent → node grandchild (matches Windows bridge shape). */
function spawnWindowsMultilevelTree(): ChildProcess {
  const launcherPath = path.join(__dirname, "bridgeChildTreeFixture.cmd");
  return spawn(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", launcherPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, CUKII_TEST_NODE_PATH: process.execPath },
    },
  );
}

async function waitForRootExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

async function taskkillTree(
  pid: number,
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const killer = spawn(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", String(pid), "/T", "/F"],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    killer.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    killer.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      killer.kill();
      reject(
        new Error(
          `taskkill timed out for pid ${pid}; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`,
        ),
      );
    }, timeoutMs);
    killer.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    killer.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function waitForPidExit(pid: number, budgetMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    // Observe death through the same tasklist probe production uses. The
    // handle-based signal-0 probe keeps reporting "alive" on Windows while
    // this test still holds the ChildProcess handle, which under machine load
    // outlasts the kill budget even after a verified kill.
    if (!(await isBridgePidAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !(await isBridgePidAlive(pid));
}

async function cleanupPid(pid: number | undefined, includeTree: boolean) {
  if (!pid || !isPidAlive(pid)) return;
  if (includeTree) {
    try {
      await taskkillTree(pid, 2_000);
    } catch {
      // Continue to the direct fallback so a failed assertion cannot leak
      // this test fixture into the developer's machine.
    }
  }
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process exited between the liveness check and the signal.
    }
  }
}

async function cleanupTree(rootPid: number | undefined, pids?: TreePids) {
  await cleanupPid(rootPid, true);
  await cleanupPid(pids?.parentPid, true);
  await cleanupPid(pids?.grandchildPid, false);
}

describe("terminateBridgeChild", () => {
  it("escalates with graceful-then-force on non-Windows", async () => {
    const child = new UncooperativeChild();
    const forceKill = vi.fn(() => {
      child.emit("close");
      child.exitCode = 1;
    });
    await expect(
      terminateBridgeChild(child, {
        platform: "linux",
        graceMs: 1,
        forceMs: 1,
        forceKill,
      }),
    ).resolves.toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(forceKill).toHaveBeenCalledTimes(1);
  });

  it("on Windows runs tree force-kill before any root-only child.kill", async () => {
    const child = new UncooperativeChild();
    const callOrder: string[] = [];
    child.kill = vi.fn(() => {
      callOrder.push("root-kill");
      return true;
    });
    const forceKill = vi.fn(async () => {
      callOrder.push("tree-kill");
      child.emit("close");
      child.exitCode = 1;
    });
    await expect(
      terminateBridgeChild(child, {
        platform: "win32",
        graceMs: 50,
        forceMs: 50,
        forceKill,
      }),
    ).resolves.toBe(true);
    expect(callOrder).toEqual(["tree-kill"]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(forceKill).toHaveBeenCalledTimes(1);
  });

  it("returns false within the force bound when termination cannot be verified", async () => {
    const child = new UncooperativeChild();
    const started = Date.now();
    await expect(
      terminateBridgeChild(child, {
        platform: "linux",
        graceMs: 1,
        forceMs: 5,
        forceKill: vi.fn(),
      }),
    ).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("returns true from verified death even when the force command reports failure", async () => {
    const child = new UncooperativeChild();
    const started = Date.now();
    await expect(
      terminateBridgeChild(child, {
        platform: "win32",
        forceMs: 25,
        forceKill: vi.fn(() => {
          child.exitCode = 1;
          return false;
        }),
      }),
    ).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(20);
  });

  it("returns false on Windows when force is accepted but no death is verified", async () => {
    const child = new UncooperativeChild();
    await expect(
      terminateBridgeChild(child, {
        platform: "win32",
        forceMs: 5,
        forceKill: vi.fn(() => true),
      }),
    ).resolves.toBe(false);
  });

  it("shares one force budget between the kill command and close verification", async () => {
    // Wall-clock bounds flake on loaded Windows runners; fake timers prove the
    // same invariant deterministically: after the force kill consumes 15ms of
    // a 20ms budget, only the remaining 5ms may elapse before the receipt.
    vi.useFakeTimers();
    try {
      const child = new UncooperativeChild();
      let settledValue: boolean | undefined;
      const pending = terminateBridgeChild(child, {
        platform: "win32",
        forceMs: 20,
        forceKill: () => new Promise((resolve) => setTimeout(resolve, 15)),
      }).then((value) => {
        settledValue = value;
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(settledValue).toBe(false);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent for an already-exited child", async () => {
    const child = new ExitedChild();
    await expect(terminateBridgeChild(child)).resolves.toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")(
    "negative control: kill-first then taskkill leaves the grandchild alive",
    async () => {
      const root = spawnWindowsMultilevelTree();
      let pids: TreePids | undefined;
      try {
        await waitForSpawn(root);
        const rootPid = root.pid;
        expect(rootPid).toBeTypeOf("number");
        pids = await readTreePids(root);
        expect(isPidAlive(pids.parentPid)).toBe(true);
        expect(isPidAlive(pids.grandchildPid)).toBe(true);

        root.kill();
        // Root-only kill orphans the Node descendants. `close` cannot arrive
        // yet because they retain cmd.exe's stdout handle; `exit` proves only
        // the root process itself is gone, which is the old broken ordering.
        await waitForRootExit(root);

        const taskkillReceipt = await taskkillTree(rootPid!);
        // Old ordering: root is already dead, so /T cannot walk the tree.
        expect(taskkillReceipt.code, JSON.stringify(taskkillReceipt)).not.toBe(0);
        expect(isPidAlive(pids.parentPid)).toBe(true);
        expect(isPidAlive(pids.grandchildPid)).toBe(true);
      } finally {
        await cleanupTree(root.pid, pids);
      }
      expect(await waitForPidExit(pids!.parentPid)).toBe(true);
      expect(await waitForPidExit(pids!.grandchildPid)).toBe(true);
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "kills a multilevel Windows tree including the grandchild",
    async () => {
      const root = spawnWindowsMultilevelTree();
      let pids: TreePids | undefined;
      try {
        await waitForSpawn(root);
        pids = await readTreePids(root);
        expect(isPidAlive(pids.parentPid)).toBe(true);
        expect(isPidAlive(pids.grandchildPid)).toBe(true);

        await expect(
          terminateBridgeChild(root, { graceMs: 50, forceMs: 10_000 }),
        ).resolves.toBe(true);
        expect(root.exitCode !== null || root.signalCode !== null).toBe(true);
        expect(await waitForPidExit(pids.parentPid)).toBe(true);
        expect(await waitForPidExit(pids.grandchildPid)).toBe(true);
      } finally {
        await cleanupTree(root.pid, pids);
      }
    },
    30_000,
  );
});

function spawnSleeperChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

describe("isBridgePidAlive", () => {
  it("reports a live child as alive and a killed child as dead", async () => {
    const child = spawnSleeperChild();
    await waitForSpawn(child);
    const pid = child.pid;
    expect(pid).toBeTypeOf("number");
    try {
      expect(await isBridgePidAlive(pid!)).toBe(true);
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      expect(await waitForPidExit(pid!)).toBe(true);
      expect(await isBridgePidAlive(pid!)).toBe(false);
    } finally {
      await cleanupPid(pid, false);
    }
  }, 30_000);
});

describe("retryBridgeTreeKill", () => {
  it("returns true without forcing when the pid is already dead", async () => {
    const forceTreeKill = vi.fn(async () => true);
    await expect(
      retryBridgeTreeKill(4242, {
        pidAlive: vi.fn(() => false),
        forceTreeKill,
      }),
    ).resolves.toBe(true);
    expect(forceTreeKill).not.toHaveBeenCalled();
  });

  it("forces the tree kill exactly once and verifies death afterwards", async () => {
    const pidAlive = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const forceTreeKill = vi.fn(async () => true);

    await expect(
      retryBridgeTreeKill(4242, {
        pidAlive,
        forceTreeKill,
        budgetMs: 1_000,
      }),
    ).resolves.toBe(true);
    expect(forceTreeKill).toHaveBeenCalledTimes(1);
    expect(forceTreeKill).toHaveBeenCalledWith(4242, expect.any(Number));
  });

  it("returns false when the pid stays alive past the budget", async () => {
    const forceTreeKill = vi.fn(async () => true);
    const started = Date.now();
    await expect(
      retryBridgeTreeKill(4242, {
        pidAlive: vi.fn(() => true),
        forceTreeKill,
        budgetMs: 60,
      }),
    ).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("kills a real bridge child through the default platform force path", async () => {
    const child = spawnSleeperChild();
    await waitForSpawn(child);
    const pid = child.pid;
    expect(pid).toBeTypeOf("number");
    try {
      await expect(
        retryBridgeTreeKill(pid!, { budgetMs: 10_000 }),
      ).resolves.toBe(true);
      expect(await waitForPidExit(pid!)).toBe(true);
    } finally {
      await cleanupPid(pid, false);
    }
  }, 30_000);
});

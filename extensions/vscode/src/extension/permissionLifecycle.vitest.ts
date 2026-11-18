import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { terminateBridgeChild } from "@cukii/vendor-bridge";
import { isRealPanelSessionTransition } from "./panelSessionTransition";

describe("Claude permission lifecycle", () => {
  it("does not replace a permission boundary for a title-only update", () => {
    expect(isRealPanelSessionTransition(undefined, "session-a")).toBe(false);
    expect(isRealPanelSessionTransition("session-a", "session-a")).toBe(false);
    expect(isRealPanelSessionTransition("session-a", "session-b")).toBe(true);
  });

  it("kills a live bridge child and awaits its close", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // Mirror how production launches a bridge (`bridgeChatAdapter.ts`):
        // POSIX teardown signals the whole process group via
        // `process.kill(-pid, …)`, which only reaches anything when the child
        // owns a group. Spawned attached, the group kill raises ESRCH,
        // `posixGroupIsAlive` then reads the missing group as "dead", and the
        // child is reported terminated while it is still running.
        detached: process.platform !== "win32",
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    // `exitCode`/`signalCode` are only populated once Node has reaped the
    // child, which is not the same instant the OS-level liveness probe inside
    // `terminateBridgeChild` sees the group disappear.
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    try {
      await expect(terminateBridgeChild(child)).resolves.toBe(true);
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }, 20_000);
});

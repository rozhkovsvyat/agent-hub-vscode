import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { terminateBridgeChild } from "./bridgeChildLifecycle";
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
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await terminateBridgeChild(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});

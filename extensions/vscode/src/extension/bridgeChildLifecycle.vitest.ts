import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { terminateBridgeChild } from "./bridgeChildLifecycle";

class UncooperativeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 1234;
  kill = vi.fn(() => true);
}

describe("terminateBridgeChild", () => {
  it("escalates when the vendor ignores the soft abort", async () => {
    const child = new UncooperativeChild();
    const forceKill = vi.fn(() => child.emit("close"));
    await terminateBridgeChild(child, { graceMs: 1, forceMs: 1, forceKill });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(forceKill).toHaveBeenCalledTimes(1);
  });

  it("returns within the force bound even if the process never closes", async () => {
    const child = new UncooperativeChild();
    const started = Date.now();
    await terminateBridgeChild(child, {
      graceMs: 1,
      forceMs: 5,
      forceKill: vi.fn(),
    });
    expect(Date.now() - started).toBeLessThan(100);
  });
});

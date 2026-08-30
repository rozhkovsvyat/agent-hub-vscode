import { describe, expect, it, vi } from "vitest";

import { BridgeRunCancellation } from "./bridgeRunCancellation";

describe("BridgeRunCancellation", () => {
  it("runs the native abort exactly once for duplicate Stop and Escape", async () => {
    const abort = vi.fn();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const cancellation = new BridgeRunCancellation(abort, done);

    const stop = cancellation.cancel();
    const escape = cancellation.cancel();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(stop.alreadyCancelled).toBe(false);
    expect(escape.alreadyCancelled).toBe(true);
    finish();
    await expect(stop.receipt).resolves.toEqual({ interrupted: "turn" });
    await expect(escape.receipt).resolves.toEqual({ interrupted: "turn" });
  });

  it("derives Tool interrupted from the native active-tool receipt state", async () => {
    const cancellation = new BridgeRunCancellation(vi.fn(), Promise.resolve());
    cancellation.toolStarted("tool-1");
    cancellation.toolStarted("tool-2");
    cancellation.toolFinished("tool-1");
    await expect(cancellation.cancel().receipt).resolves.toEqual({
      interrupted: "tool",
    });
  });
});

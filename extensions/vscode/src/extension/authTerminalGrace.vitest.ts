import { describe, expect, it, vi } from "vitest";

import { terminalCloseAfterAuthGrace } from "./authTerminalGrace";

describe("terminalCloseAfterAuthGrace", () => {
  it("does not let a fast terminal close beat the native auth watcher", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let settled = false;
      const outcome = terminalCloseAfterAuthGrace(
        Promise.resolve("terminal-closed"),
        controller.signal,
        5_000,
      ).then((value) => {
        settled = true;
        return value;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toBe("terminal-closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases its timer when another race branch wins", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const outcome = terminalCloseAfterAuthGrace(
        Promise.resolve("terminal-closed"),
        controller.signal,
      );
      await Promise.resolve();
      controller.abort();
      await expect(outcome).resolves.toBe("terminal-closed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

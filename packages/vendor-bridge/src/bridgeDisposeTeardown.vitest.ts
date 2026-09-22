import { describe, expect, it, vi } from "vitest";

import { retryBridgeTeardownOnDispose } from "./bridgeDisposeTeardown";

function unverifiedRun(childPid?: number) {
  return {
    runId: "run-1",
    sessionId: "session-1",
    done: Promise.resolve({ terminationVerified: false, childPid }),
  };
}

describe("retryBridgeTeardownOnDispose", () => {
  it("retries the tree kill once when cancellation was refused", async () => {
    const forceTreeKill = vi.fn(async () => true);
    // Alive on the pre-check, dead after the forced kill.
    const pidAlive = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const log = vi.fn();

    const result = await retryBridgeTeardownOnDispose(unverifiedRun(4242), {
      forceTreeKill,
      pidAlive,
      log,
      budgetMs: 1_000,
    });

    expect(result).toEqual({ verified: true });
    expect(forceTreeKill).toHaveBeenCalledTimes(1);
    expect(forceTreeKill).toHaveBeenCalledWith(4242, expect.any(Number));
    // A successful retry leaves no orphan and therefore no alarm.
    expect(log).not.toHaveBeenCalled();
  });

  it("logs the orphan pid and manual kill command when the retry fails", async () => {
    const forceTreeKill = vi.fn(async () => true);
    const log = vi.fn();

    const result = await retryBridgeTeardownOnDispose(unverifiedRun(4242), {
      forceTreeKill,
      pidAlive: vi.fn(() => true),
      log,
      budgetMs: 60,
    });

    expect(result).toEqual({ verified: false });
    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0]?.[0] as string;
    expect(message).toContain("4242");
    expect(message).toContain("run-1");
    expect(message).toMatch(/taskkill|kill -9/);
  });

  it("reports an unverified teardown with no known pid instead of swallowing it", async () => {
    const forceTreeKill = vi.fn(async () => true);
    const log = vi.fn();

    const result = await retryBridgeTeardownOnDispose(
      unverifiedRun(undefined),
      {
        forceTreeKill,
        pidAlive: vi.fn(() => true),
        log,
      },
    );

    expect(result).toEqual({ verified: false });
    expect(forceTreeKill).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("run-1");
  });
});

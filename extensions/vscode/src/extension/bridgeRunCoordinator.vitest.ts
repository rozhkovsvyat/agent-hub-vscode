import { describe, expect, it, vi } from "vitest";

import {
  BridgeRunCoordinator,
  bridgeRunAcceptsSteer,
  type BridgeRunIdentity,
} from "./bridgeRunCoordinator";

type Run = BridgeRunIdentity & { label: string };

function run(label: string, brokerModel: Run["brokerModel"] = "opus-5"): Run {
  return {
    runId: label,
    sessionId: "session-1",
    brokerModel,
    label,
  };
}

describe("BridgeRunCoordinator", () => {
  it("coalesces ten rapid replacements behind one cancellation barrier", async () => {
    const coordinator = new BridgeRunCoordinator<string, Run>(1_000);
    const active = run("active");
    await expect(
      coordinator.acquire("panel", active, async () => true),
    ).resolves.toBe("acquired");

    let finishCancellation!: (result: boolean) => void;
    const cancellation = new Promise<boolean>((resolve) => {
      finishCancellation = resolve;
    });
    const cancel = vi.fn(() => cancellation);
    const candidates = Array.from({ length: 10 }, (_, index) =>
      run(`candidate-${index + 1}`),
    );
    const replacements = candidates.map((candidate) =>
      coordinator.acquire("panel", candidate, cancel),
    );

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(coordinator.activeFor("panel")).toBe(active);
    finishCancellation(true);

    const results = await Promise.all(replacements);
    expect(results.filter((result) => result === "superseded")).toHaveLength(9);
    expect(results.filter((result) => result === "acquired")).toHaveLength(1);
    expect(coordinator.activeFor("panel")).toBe(candidates.at(-1));
  });

  it("does not replace a run whose termination was not verified", async () => {
    const coordinator = new BridgeRunCoordinator<string, Run>(1_000);
    const active = run("active");
    const candidate = run("candidate");
    await coordinator.acquire("panel", active, async () => true);

    await expect(
      coordinator.acquire("panel", candidate, async () => false),
    ).resolves.toBe("blocked");
    expect(coordinator.activeFor("panel")).toBe(active);
  });

  it("bounds a cancellation that never resolves", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new BridgeRunCoordinator<string, Run>(50);
      const active = run("active");
      await coordinator.acquire("panel", active, async () => true);
      const replacement = coordinator.acquire(
        "panel",
        run("candidate"),
        async () => new Promise<boolean>(() => undefined),
      );

      await vi.advanceTimersByTimeAsync(50);
      await expect(replacement).resolves.toBe("blocked");
      expect(coordinator.activeFor("panel")).toBe(active);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never routes a model-switched steer to the run being replaced", async () => {
    const coordinator = new BridgeRunCoordinator<string, Run>(1_000);
    const sol = run("sol", "codex-5-6-sol");
    const qwen = run("qwen", "qwen");
    await coordinator.acquire("panel", sol, async () => true);
    let finishCancellation!: (result: boolean) => void;
    const replacement = coordinator.acquire(
      "panel",
      qwen,
      async () =>
        new Promise<boolean>((resolve) => {
          finishCancellation = resolve;
        }),
    );

    expect(
      bridgeRunAcceptsSteer(coordinator.activeFor("panel"), {
        sessionId: "session-1",
        brokerModel: "qwen",
      }),
    ).toBe(false);
    finishCancellation(true);
    await expect(replacement).resolves.toBe("acquired");
    expect(
      bridgeRunAcceptsSteer(coordinator.activeFor("panel"), {
        sessionId: "session-1",
        brokerModel: "qwen",
      }),
    ).toBe(true);
  });

  it("releases only the matching active run", async () => {
    const coordinator = new BridgeRunCoordinator<string, Run>();
    const active = run("active");
    await coordinator.acquire("panel", active, async () => true);

    coordinator.release("panel", run("stale"));
    expect(coordinator.activeFor("panel")).toBe(active);
    coordinator.release("panel", active);
    expect(coordinator.activeFor("panel")).toBeUndefined();
  });

  it("forget invalidates a replacement waiting behind cancellation", async () => {
    const coordinator = new BridgeRunCoordinator<string, Run>(1_000);
    const active = run("active");
    await coordinator.acquire("panel", active, async () => true);
    let finishCancellation!: (result: boolean) => void;
    const replacement = coordinator.acquire(
      "panel",
      run("replacement"),
      async () =>
        new Promise<boolean>((resolve) => {
          finishCancellation = resolve;
        }),
    );

    coordinator.forget("panel");
    finishCancellation(true);

    await expect(replacement).resolves.toBe("superseded");
    expect(coordinator.activeFor("panel")).toBeUndefined();
  });

  it("reclaims a zombie slot whose occupant pid is verifiably dead", async () => {
    const coordinator = new BridgeRunCoordinator<string, Run>(1_000, {
      isPidAlive: (pid) => pid !== 4242,
    });
    const zombie: Run = { ...run("zombie"), childPid: 4242 };
    await coordinator.acquire("panel", zombie, async () => true);

    const cancel = vi.fn(async () => false);
    await expect(
      coordinator.acquire("panel", run("replacement"), cancel),
    ).resolves.toBe("acquired");
    // The dead occupant must be dropped by liveness, never cancelled.
    expect(cancel).not.toHaveBeenCalled();
    expect(coordinator.activeFor("panel")?.runId).toBe("replacement");
  });

  it("keeps blocking replacement of a live-pid run with unverified teardown", async () => {
    const coordinator = new BridgeRunCoordinator<string, Run>(1_000, {
      isPidAlive: () => true,
    });
    const active: Run = { ...run("active"), childPid: 4242 };
    await coordinator.acquire("panel", active, async () => true);

    await expect(
      coordinator.acquire("panel", run("candidate"), async () => false),
    ).resolves.toBe("blocked");
    expect(coordinator.activeFor("panel")).toBe(active);
  });
});

describe("bridgeRunAcceptsSteer", () => {
  it("rejects a steer after the selected model changed", () => {
    const active = run("active", "codex-5-6-sol");
    expect(
      bridgeRunAcceptsSteer(active, {
        sessionId: "session-1",
        brokerModel: "qwen",
      }),
    ).toBe(false);
  });

  it("defers an unbound legacy steer rather than risking the wrong model", () => {
    expect(
      bridgeRunAcceptsSteer(run("active"), { sessionId: "session-1" }),
    ).toBe(false);
  });
});

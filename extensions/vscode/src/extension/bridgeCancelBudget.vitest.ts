import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_CANCEL_COMPLETION_MS,
  BRIDGE_CANCEL_RECEIPT_MS,
  cancelDecision,
  settledWithin,
  TIMED_OUT,
} from "./bridgeCancelBudget";

describe("settledWithin", () => {
  it("passes a value straight through", async () => {
    await expect(settledWithin(Promise.resolve("ok"), 50)).resolves.toBe("ok");
  });

  it("passes undefined through without confusing it for a timeout", async () => {
    // The whole point of a symbol sentinel: a run whose completion is
    // legitimately undefined must not be read as "never answered".
    await expect(
      settledWithin(Promise.resolve(undefined), 50),
    ).resolves.toBeUndefined();
  });

  it("gives up on a promise that never settles", async () => {
    vi.useFakeTimers();
    try {
      let outcome: unknown;
      const pending = settledWithin(new Promise(() => {}), 1_000).then((v) => {
        outcome = v;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(outcome).toBe(TIMED_OUT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a rejection as a timeout rather than throwing", async () => {
    // A teardown error must not escape and abort the recovery that frees the
    // run slot; it is simply another way of not knowing.
    await expect(
      settledWithin(Promise.reject(new Error("teardown blew up")), 50),
    ).resolves.toBe(TIMED_OUT);
  });

  it("does not resolve late once the promise won the race", async () => {
    vi.useFakeTimers();
    try {
      const seen: unknown[] = [];
      const pending = settledWithin(Promise.resolve(7), 100).then((v) =>
        seen.push(v),
      );
      await pending;
      await vi.advanceTimersByTimeAsync(500);
      expect(seen).toEqual([7]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the Stop budget at the coordinator's replacement window", () => {
    expect(BRIDGE_CANCEL_RECEIPT_MS).toBe(12_000);
    expect(BRIDGE_CANCEL_COMPLETION_MS).toBeLessThan(BRIDGE_CANCEL_RECEIPT_MS);
  });
});

describe("cancelDecision", () => {
  it("accepts a verified termination and reports the real interrupt kind", () => {
    expect(
      cancelDecision({
        receipt: { interrupted: "tool" },
        completion: { terminationVerified: true, childPid: 42 },
        runChildPid: 42,
      }),
    ).toEqual({
      interrupted: "tool",
      terminationVerified: true,
      probePid: 42,
    });
  });

  it("never reads silence as a verified termination", () => {
    expect(
      cancelDecision({
        receipt: TIMED_OUT,
        completion: TIMED_OUT,
        runChildPid: 99,
      }).terminationVerified,
    ).toBe(false);
  });

  it("falls back to the run's own pid when the completion never answered", () => {
    // This is what makes a stalled run recoverable: the completion carries the
    // pid, so without this the probe would have nothing to ask about and the
    // slot would stay occupied for the life of the panel.
    expect(
      cancelDecision({
        receipt: TIMED_OUT,
        completion: TIMED_OUT,
        runChildPid: 1234,
      }).probePid,
    ).toBe(1234);
  });

  it("reports no pid at all when the run never reached spawn", () => {
    // Nothing spawned means nothing can outlive the run, so the caller frees
    // the slot instead of refusing every later submit.
    expect(
      cancelDecision({
        receipt: TIMED_OUT,
        completion: TIMED_OUT,
        runChildPid: undefined,
      }).probePid,
    ).toBeUndefined();
  });

  it("prefers the completion's pid over the run's when both are known", () => {
    expect(
      cancelDecision({
        receipt: { interrupted: "turn" },
        completion: { terminationVerified: false, childPid: 7 },
        runChildPid: 8,
      }).probePid,
    ).toBe(7);
  });

  it("degrades an unanswered receipt to a turn interrupt, never a tool one", () => {
    // Claiming a tool was interrupted would put a tool result in the
    // transcript that no tool ever produced.
    expect(
      cancelDecision({
        receipt: TIMED_OUT,
        completion: { terminationVerified: true },
      }).interrupted,
    ).toBe("turn");
  });

  it("keeps an unverified completion unverified even with a live receipt", () => {
    expect(
      cancelDecision({
        receipt: { interrupted: "turn" },
        completion: { terminationVerified: false, childPid: 5 },
      }),
    ).toEqual({
      interrupted: "turn",
      terminationVerified: false,
      probePid: 5,
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  BRIDGE_SILENCE_LIMITS,
  bridgeSilenceLimits,
  BridgeSilenceWatchdog,
  bridgeStartupAdvice,
} from "./bridgeSilenceWatchdog";

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("BridgeSilenceWatchdog", () => {
  it("fails a launch that never emits stdout", () => {
    const time = clock();
    const watchdog = new BridgeSilenceWatchdog(BRIDGE_SILENCE_LIMITS, time);
    expect(watchdog.poll()).toEqual({ kind: "ok" });
    time.advance(BRIDGE_SILENCE_LIMITS.firstOutputWarnMs);
    const warn = watchdog.poll();
    expect(warn.kind).toBe("warn");
    expect(warn.kind === "warn" && warn.text).toMatch(/still silent/i);
    expect(watchdog.poll()).toEqual({ kind: "ok" });
    time.advance(
      BRIDGE_SILENCE_LIMITS.firstOutputFailMs -
        BRIDGE_SILENCE_LIMITS.firstOutputWarnMs,
    );
    const fail = watchdog.poll();
    expect(fail.kind).toBe("fail");
    expect(fail.kind === "fail" && fail.text).toMatch(/no output/i);
    expect(watchdog.poll()).toEqual({ kind: "ok" });
  });

  it("does not treat an in-flight tool as a hang at the idle bound", () => {
    const time = clock();
    const watchdog = new BridgeSilenceWatchdog(BRIDGE_SILENCE_LIMITS, time);
    watchdog.noteActivity();
    watchdog.noteToolStart();
    time.advance(BRIDGE_SILENCE_LIMITS.idleFailMs);
    expect(watchdog.poll()).toEqual({ kind: "ok" });
    time.advance(
      BRIDGE_SILENCE_LIMITS.toolIdleFailMs - BRIDGE_SILENCE_LIMITS.idleFailMs,
    );
    const fail = watchdog.poll();
    expect(fail.kind).toBe("fail");
    expect(fail.kind === "fail" && fail.text).toMatch(/tool is still running/i);
  });

  it("fails a quiet vendor after first output when no tool is running", () => {
    const time = clock();
    const watchdog = new BridgeSilenceWatchdog(BRIDGE_SILENCE_LIMITS, time);
    watchdog.noteActivity();
    time.advance(BRIDGE_SILENCE_LIMITS.idleFailMs);
    const fail = watchdog.poll();
    expect(fail.kind).toBe("fail");
    expect(fail.kind === "fail" && fail.text).toMatch(/no in-flight tool/i);
  });

  it("resets the idle clock when a tool finishes", () => {
    const time = clock();
    const watchdog = new BridgeSilenceWatchdog(BRIDGE_SILENCE_LIMITS, time);
    watchdog.noteToolStart();
    time.advance(BRIDGE_SILENCE_LIMITS.idleFailMs);
    watchdog.noteToolFinish();
    expect(watchdog.poll()).toEqual({ kind: "ok" });
    time.advance(BRIDGE_SILENCE_LIMITS.idleWarnMs - 1);
    expect(watchdog.poll()).toEqual({ kind: "ok" });
  });

  // Card CUK-111: the measured first stdout byte was 300.4 s from the owner's
  // workspace, against a 180 s budget. A Grok launch must survive it.
  it("keeps a starting Grok alive past the generic first-output budget", () => {
    const time = clock();
    const limits = bridgeSilenceLimits("grok");
    const watchdog = new BridgeSilenceWatchdog(
      limits,
      time,
      bridgeStartupAdvice("grok"),
    );
    time.advance(BRIDGE_SILENCE_LIMITS.firstOutputFailMs + 1);
    // Warning is fine — killing the run is not.
    expect(watchdog.poll().kind).not.toBe("fail");
    time.advance(300_000 - BRIDGE_SILENCE_LIMITS.firstOutputFailMs);
    expect(watchdog.poll().kind).not.toBe("fail");
    watchdog.noteActivity();
    expect(watchdog.poll()).toEqual({ kind: "ok" });
  });

  it("still fails closed on a Grok that never starts, and says why", () => {
    const time = clock();
    const watchdog = new BridgeSilenceWatchdog(
      bridgeSilenceLimits("grok"),
      time,
      bridgeStartupAdvice("grok"),
    );
    time.advance(bridgeSilenceLimits("grok").firstOutputWarnMs);
    const warn = watchdog.poll();
    expect(warn.kind === "warn" && warn.text).toMatch(/MCP handshakes/i);
    time.advance(bridgeSilenceLimits("grok").firstOutputFailMs);
    const fail = watchdog.poll();
    expect(fail.kind).toBe("fail");
    expect(fail.kind === "fail" && fail.text).toMatch(/grok mcp doctor/);
    // The generic advice is wrong here: another model does not shorten this
    // vendor's own startup, and a resend pays it again.
    expect(fail.kind === "fail" && fail.text).not.toMatch(/pick another model/);
  });

  it("leaves every other vendor on the generic budget and advice", () => {
    expect(bridgeSilenceLimits("claude")).toEqual(BRIDGE_SILENCE_LIMITS);
    expect(bridgeSilenceLimits("kimi").firstOutputFailMs).toBe(
      BRIDGE_SILENCE_LIMITS.firstOutputFailMs,
    );
    expect(bridgeStartupAdvice("codex").failed).toMatch(/pick another model/);
    const time = clock();
    const watchdog = new BridgeSilenceWatchdog(
      bridgeSilenceLimits("claude"),
      time,
      bridgeStartupAdvice("claude"),
    );
    time.advance(BRIDGE_SILENCE_LIMITS.firstOutputFailMs);
    expect(watchdog.poll().kind).toBe("fail");
  });

  // Once the vendor has spoken, its startup grace is over: a Grok that goes
  // quiet mid-turn is still failed closed on the ordinary idle bound.
  it("drops Grok back to the ordinary idle bound after first output", () => {
    const time = clock();
    const watchdog = new BridgeSilenceWatchdog(
      bridgeSilenceLimits("grok"),
      time,
      bridgeStartupAdvice("grok"),
    );
    watchdog.noteActivity();
    time.advance(BRIDGE_SILENCE_LIMITS.idleFailMs);
    expect(watchdog.poll().kind).toBe("fail");
  });
});

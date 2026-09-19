import { describe, expect, it } from "vitest";

import {
  BRIDGE_SILENCE_LIMITS,
  BridgeSilenceWatchdog,
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
});

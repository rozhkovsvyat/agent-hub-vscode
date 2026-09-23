import { describe, expect, it } from "vitest";

import {
  BRIDGE_SILENCE_LIMITS,
  bridgeSilenceLimits,
  BridgeSilenceWatchdog,
  bridgeStartupAdvice,
  reportsToolsAfterTheFact,
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

  // Card 0d7dfdd6: kimi narrates a tool call and its result in the same
  // instant, so `activeTools` is never above zero on that route. The 15-minute
  // idle bound then killed long internal work and the receipt blamed a
  // condition the route can never contradict.
  it("gives a post-hoc tool reporter the tool-backed idle budget", () => {
    expect(bridgeSilenceLimits("kimi").idleFailMs).toBe(
      BRIDGE_SILENCE_LIMITS.toolIdleFailMs,
    );
    expect(bridgeSilenceLimits("kimi").idleWarnMs).toBe(
      BRIDGE_SILENCE_LIMITS.toolIdleWarnMs,
    );
    // Vendors that stream a real tool start keep the tighter idle bound.
    expect(bridgeSilenceLimits("cursor").idleFailMs).toBe(
      BRIDGE_SILENCE_LIMITS.idleFailMs,
    );
    expect(bridgeSilenceLimits("claude").idleFailMs).toBe(
      BRIDGE_SILENCE_LIMITS.idleFailMs,
    );
    // Grok's widened startup budget must survive the idle override.
    expect(bridgeSilenceLimits("grok").firstOutputFailMs).toBe(600_000);
    expect(reportsToolsAfterTheFact("kimi")).toBe(true);
    expect(reportsToolsAfterTheFact("grok")).toBe(false);
  });

  it("does not claim an unobservable in-flight tool for a post-hoc reporter", () => {
    const time = clock();
    const watchdog = new BridgeSilenceWatchdog(
      bridgeSilenceLimits("kimi"),
      time,
      bridgeStartupAdvice("kimi"),
      reportsToolsAfterTheFact("kimi"),
    );
    watchdog.noteActivity();
    time.advance(BRIDGE_SILENCE_LIMITS.toolIdleFailMs);
    const fail = watchdog.poll();
    expect(fail.kind).toBe("fail");
    expect(fail.kind === "fail" && fail.text).toMatch(
      /reports tools only after running them/i,
    );
    expect(fail.kind === "fail" && fail.text).not.toMatch(/no in-flight tool/i);
  });

  // Card d10fd9a0: a broken MCP server makes Grok print a tool call and then
  // wait forever. That stall is indistinguishable from a slow tool until the
  // receipt names the server, so the known cause must reach the idle verdict —
  // not only the never-started one.
  it("carries a known stall cause into the idle receipt", () => {
    const broken = "Cukii cannot find the program for playwright.";
    const advice = bridgeStartupAdvice("grok", {
      failed: broken,
      stalled: broken,
    });
    expect(advice.failed).toBe(broken);
    expect(advice.stalled).toBe(broken);

    // Weak evidence must not be promoted into a launch verdict.
    const stallOnly = bridgeStartupAdvice("grok", { stalled: broken });
    expect(stallOnly.failed).toMatch(/grok mcp doctor/);
    expect(stallOnly.stalled).toBe(broken);

    const time = clock();
    const watchdog = new BridgeSilenceWatchdog(
      bridgeSilenceLimits("grok"),
      time,
      advice,
    );
    watchdog.noteActivity();
    watchdog.noteToolStart();
    time.advance(BRIDGE_SILENCE_LIMITS.toolIdleFailMs);
    const fail = watchdog.poll();
    expect(fail.kind).toBe("fail");
    expect(fail.kind === "fail" && fail.text).toMatch(/tool is still running/i);
    expect(fail.kind === "fail" && fail.text).toContain(broken);
  });

  it("keeps the generic idle receipt clean when no cause is known", () => {
    const time = clock();
    const watchdog = new BridgeSilenceWatchdog(
      bridgeSilenceLimits("grok"),
      time,
      bridgeStartupAdvice("grok"),
    );
    watchdog.noteActivity();
    time.advance(BRIDGE_SILENCE_LIMITS.idleFailMs);
    const fail = watchdog.poll();
    expect(fail.kind).toBe("fail");
    // The startup advice explains a launch that never printed; a turn that
    // spoke and stalled must not inherit it.
    expect(fail.kind === "fail" && fail.text).not.toMatch(/grok mcp doctor/);
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

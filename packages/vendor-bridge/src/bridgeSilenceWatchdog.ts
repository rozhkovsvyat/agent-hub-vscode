import type { BrokerVendorId } from "core/protocol/ideWebview";

/**
 * Bounds a native bridge run that is alive but silent. Tool-backed waits are
 * allowed to run long; a child that never speaks, or that goes quiet after
 * speaking with no in-flight tool, is treated as stuck so Stop/next-prompt
 * can proceed without a tab reload.
 */
export const BRIDGE_SILENCE_LIMITS = {
  firstOutputWarnMs: 90_000,
  firstOutputFailMs: 180_000,
  idleWarnMs: 5 * 60_000,
  idleFailMs: 15 * 60_000,
  toolIdleWarnMs: 20 * 60_000,
  toolIdleFailMs: 45 * 60_000,
} as const;

/**
 * 🔴 Grok prints nothing — not one byte — until its entire session setup has
 * finished, because its first stdout line is the `system/init` envelope that
 * must already carry every MCP server's status. That setup is not bounded by
 * the vendor's own `timeout_sec = 30`: a handshake round that misses its mark
 * is retried up to a hard 70 s ceiling (`MCP background handshakes completed
 * in 70.01s`), session hooks run before it, and the context snapshot makes
 * network calls that time out on a machine with restricted egress.
 *
 * Measured with the exact argv this adapter builds (board card CUK-111,
 * 2026-09-20): the same CLI, same model and same prompt answered in 9-11 s
 * from a small directory and in **300.4 s** from the owner's loaded workspace.
 * The model itself was never slow — its debug log shows `ttft_ms=3467` and a
 * finished `stop_reason="stop"` in both runs. So a single 180 s budget killed
 * a healthy run that already held its answer, then told the owner to "pick
 * another model", which cannot help: the next launch pays the same setup.
 *
 * Only the pre-first-output phase is widened. Once the vendor has spoken, the
 * ordinary idle limits apply again, so a genuinely wedged Grok is still
 * failed closed.
 */
export const BRIDGE_VENDOR_STARTUP_LIMITS: Partial<
  Record<
    BrokerVendorId,
    { firstOutputWarnMs: number; firstOutputFailMs: number }
  >
> = {
  grok: { firstOutputWarnMs: 60_000, firstOutputFailMs: 600_000 },
};

/**
 * 🔴 Kimi reports a tool call and its result in the same instant: its NDJSON
 * carries `{role:"assistant",tool_calls}` immediately followed by
 * `{role:"tool"}`, because the CLI runs the tool itself and only then narrates
 * it. Every `bridge.tool.start`/`bridge.tool.finish` pair in a live kimi-k3
 * session shares a millisecond, while the same pairs from opus-5 and
 * cursor:kimi-k3 stand seconds apart (card 0d7dfdd6, diagnostics 2026-09-21).
 *
 * So on this route `activeTools` is never above zero, no matter what the
 * vendor is doing. The idle budget therefore always applied, a turn running a
 * long internal tool chain was failed closed at 15 minutes, and the receipt
 * blamed "no in-flight tool" — a condition that is true of the route itself,
 * not an observation about that run.
 *
 * Until the vendor streams a tool start of its own, silence here is not
 * evidence of being stuck, so it gets the tool-backed budget.
 */
export const VENDORS_REPORTING_TOOLS_AFTER_THE_FACT: readonly BrokerVendorId[] =
  ["kimi"];

export function reportsToolsAfterTheFact(vendor: BrokerVendorId): boolean {
  return VENDORS_REPORTING_TOOLS_AFTER_THE_FACT.includes(vendor);
}

export function bridgeSilenceLimits(
  vendor: BrokerVendorId,
): SilenceWatchdogLimits {
  const startup = BRIDGE_VENDOR_STARTUP_LIMITS[vendor];
  const base = startup
    ? { ...BRIDGE_SILENCE_LIMITS, ...startup }
    : BRIDGE_SILENCE_LIMITS;
  if (!reportsToolsAfterTheFact(vendor)) return base;
  return {
    ...base,
    idleWarnMs: base.toolIdleWarnMs,
    idleFailMs: base.toolIdleFailMs,
  };
}

/**
 * What the owner should actually do, per vendor. The generic advice ("send it
 * again, or pick another model") is wrong for a vendor whose silence is its
 * own startup: repeating the prompt repeats the wait, and the model was never
 * the problem. `grok mcp doctor` names the server that did not come up.
 */
export type BridgeVendorAdvice = {
  waiting: string;
  failed: string;
  /**
   * Said when the vendor spoke and then went quiet. A launch that never
   * printed and a turn that stalled mid-tool have different causes, so the
   * generic idle receipt must not inherit the startup advice.
   */
  stalled?: string;
};

/**
 * What the owner should actually do, per vendor. The generic advice ("send it
 * again, or pick another model") is wrong for a vendor whose silence is its
 * own startup: repeating the prompt repeats the wait, and the model was never
 * the problem.
 *
 * `mcp`, when Cukii has something concrete to say about Grok's MCP servers,
 * replaces the generic pointer to `grok mcp doctor`: it already names the
 * offender, and sending the owner to run a diagnostic Cukii has effectively
 * just run is not advice (card d10fd9a0). The two faces of that fault differ
 * in strength, so they are kept apart: only an unstartable program is allowed
 * to explain a launch, while the weaker fetch-on-start evidence is offered
 * once a turn has already stalled.
 */
export function bridgeStartupAdvice(
  vendor: BrokerVendorId,
  mcp?: { failed?: string; stalled?: string },
): BridgeVendorAdvice {
  if (vendor === "grok") {
    return {
      waiting:
        "Grok stays silent until its whole session is set up — MCP handshakes alone " +
        "have a 70 s ceiling of their own. The run is alive; Cukii keeps waiting.",
      failed:
        mcp?.failed ??
        "Grok never finished starting its session, so it never printed anything — " +
          "this is its MCP/hook startup, not the model. Run `grok mcp doctor` to see " +
          "which server does not come up.",
      stalled: mcp?.stalled,
    };
  }
  return {
    waiting: "Waiting a bit longer, then this turn will be failed closed.",
    failed: "Send the message again, or pick another model.",
  };
}

export type SilenceWatchdogLimits = {
  firstOutputWarnMs: number;
  firstOutputFailMs: number;
  idleWarnMs: number;
  idleFailMs: number;
  toolIdleWarnMs: number;
  toolIdleFailMs: number;
};

export type SilenceWatchdogClock = {
  now(): number;
};

export type SilenceVerdict =
  | { kind: "ok" }
  | { kind: "warn"; text: string }
  | { kind: "fail"; text: string };

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

export class BridgeSilenceWatchdog {
  private readonly startedAt: number;
  private lastActivityAt: number;
  private firstOutput = false;
  private activeTools = 0;
  private warned = false;
  private failed = false;

  constructor(
    private readonly limits: SilenceWatchdogLimits = BRIDGE_SILENCE_LIMITS,
    private readonly clock: SilenceWatchdogClock = { now: Date.now },
    private readonly advice: BridgeVendorAdvice = {
      waiting: "Waiting a bit longer, then this turn will be failed closed.",
      failed: "Send the message again, or pick another model.",
    },
    /**
     * True where the vendor narrates tools only after running them, so this
     * watchdog can never observe one in flight and must not claim it did.
     */
    private readonly toolsReportedAfterTheFact = false,
  ) {
    const now = this.clock.now();
    this.startedAt = now;
    this.lastActivityAt = now;
  }

  noteActivity(): void {
    this.lastActivityAt = this.clock.now();
    this.firstOutput = true;
    this.warned = false;
  }

  noteToolStart(): void {
    this.activeTools += 1;
    this.noteActivity();
  }

  noteToolFinish(): void {
    this.activeTools = Math.max(0, this.activeTools - 1);
    this.noteActivity();
  }

  poll(): SilenceVerdict {
    if (this.failed) return { kind: "ok" };
    const now = this.clock.now();
    const quietMs = now - this.lastActivityAt;
    if (!this.firstOutput) {
      if (quietMs >= this.limits.firstOutputFailMs) {
        this.failed = true;
        return {
          kind: "fail",
          text:
            `Native vendor produced no output for ${seconds(quietMs)} after launch. ` +
            `Cukii stopped waiting so the chat can continue. ${this.advice.failed}`,
        };
      }
      if (quietMs >= this.limits.firstOutputWarnMs && !this.warned) {
        this.warned = true;
        return {
          kind: "warn",
          text:
            `Native vendor is still silent ${seconds(now - this.startedAt)} after launch. ` +
            `${this.advice.waiting}\n`,
        };
      }
      return { kind: "ok" };
    }

    const failMs =
      this.activeTools > 0
        ? this.limits.toolIdleFailMs
        : this.limits.idleFailMs;
    const warnMs =
      this.activeTools > 0
        ? this.limits.toolIdleWarnMs
        : this.limits.idleWarnMs;
    if (quietMs >= failMs) {
      this.failed = true;
      const observed =
        this.activeTools > 0
          ? `Native vendor has been silent for ${seconds(quietMs)} while a tool is still running. Cukii stopped waiting so the chat can continue.`
          : this.toolsReportedAfterTheFact
            ? // This vendor narrates a tool only once it has run, so silence
              // cannot be told apart from a long tool. Say what was seen.
              `Native vendor has been silent for ${seconds(quietMs)}. This CLI reports tools only after running them, so Cukii cannot tell a long tool from a stuck turn. Cukii stopped waiting so the chat can continue.`
            : `Native vendor has been silent for ${seconds(quietMs)} with no in-flight tool. Cukii stopped waiting so the chat can continue.`;
      return {
        kind: "fail",
        // A stall with a known cause must say the cause: a tool that never
        // returns because its MCP server never started looks exactly like a
        // slow tool until Cukii names the server.
        text: this.advice.stalled
          ? `${observed} ${this.advice.stalled}`
          : observed,
      };
    }
    if (quietMs >= warnMs && !this.warned) {
      this.warned = true;
      return {
        kind: "warn",
        text:
          `Native vendor has been silent for ${seconds(quietMs)}. ` +
          "If this is a long wait, it should emit a status line; otherwise the turn will be failed closed.\n",
      };
    }
    return { kind: "ok" };
  }
}

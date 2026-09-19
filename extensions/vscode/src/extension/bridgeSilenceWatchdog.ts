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
            "Cukii stopped waiting so the chat can continue. Send the message again, or pick another model.",
        };
      }
      if (quietMs >= this.limits.firstOutputWarnMs && !this.warned) {
        this.warned = true;
        return {
          kind: "warn",
          text:
            `Native vendor is still silent ${seconds(now - this.startedAt)} after launch. ` +
            "Waiting a bit longer, then this turn will be failed closed.\n",
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
      return {
        kind: "fail",
        text:
          this.activeTools > 0
            ? `Native vendor has been silent for ${seconds(quietMs)} while a tool is still running. Cukii stopped waiting so the chat can continue.`
            : `Native vendor has been silent for ${seconds(quietMs)} with no in-flight tool. Cukii stopped waiting so the chat can continue.`,
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

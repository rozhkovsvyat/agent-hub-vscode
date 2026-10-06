import type * as vscode from "vscode";
import { v4 as uuidv4 } from "uuid";

/**
 * Renderer-freeze watchdog (cards 48c3df0d, d0ddcd8c, 86baeada).
 *
 * In the reported freezes even the webview's timers were dead, so nothing
 * inside the panel could notice or report: the 45 s report timeout never
 * fired and the ring buffer stayed empty. Only the extension host stays
 * alive in that state, so the host pings every visible Cukii webview and
 * says so when pongs stop, instead of a dead panel the owner has to
 * diagnose by trial.
 *
 * Recovery is a window reload, never a panel reload: fresh HTML is delivered
 * as a message into the very page that hangs. Measured 06.10 on an isolated
 * VS Code with a busy-looping sidebar: new HTML left it hung, and the reloaded
 * sidebar came back in the same hung renderer process (blank Cukii) until
 * that process was killed. Hence the second step in the message. A chat tab
 * open next to it ran in a process of its own and kept answering.
 */
export const CUKII_HEARTBEAT_INTERVAL_MS = 15_000;
export const CUKII_HEARTBEAT_TIMEOUT_MS = 45_000;
export const CUKII_HEARTBEAT_MESSAGE_TYPE = "cukii/heartbeat";

export const CUKII_HEARTBEAT_RELOAD_WINDOW = "Reload Window";

export interface CukiiHeartbeatTarget {
  id: string;
  label: string;
  webview: () => vscode.Webview | undefined;
  visible: () => boolean;
}

export interface CukiiHeartbeatDeps {
  targets: () => CukiiHeartbeatTarget[];
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  windowFocused?: () => boolean;
  onWindowFocusChange?: (
    listener: (focused: boolean) => void,
  ) => { dispose(): void } | void;
  showWarning: (
    message: string,
    ...actions: string[]
  ) => Thenable<string | undefined>;
  executeCommand: (command: string) => Thenable<unknown>;
}

interface TargetState {
  lastPongAt: number;
  flagged: boolean;
  subscribed?: vscode.Webview;
  disposeSubscription?: () => void;
}

/**
 * A tick this late means the extension host itself stalled, and a pong may be
 * sitting in its queue behind this very timer. Judging then would blame a
 * live page for the host's pause (review of 06.10), so the tick only resets.
 */
const HOST_STALL_MS = CUKII_HEARTBEAT_INTERVAL_MS * 1.5;

export class CukiiWebviewHeartbeat {
  private readonly states = new Map<string, TargetState>();
  private readonly focusSubscription: { dispose(): void } | void;
  private readonly timer: unknown;
  private lastTickAt: number;
  private disposed = false;

  constructor(private readonly deps: CukiiHeartbeatDeps) {
    const now = this.now();
    this.lastTickAt = now;
    try {
      for (const target of this.deps.targets()) {
        this.states.set(target.id, { lastPongAt: now, flagged: false });
      }
    } catch {
      // Surfaces that cannot be listed yet are picked up by the first tick.
    }
    this.focusSubscription = this.deps.onWindowFocusChange?.((focused) => {
      // A background window throttles webview timers hard; pongs would lag
      // past the timeout without anything being frozen.
      if (focused) this.resetBaselines();
    });
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = setTimer(() => this.tick(), CUKII_HEARTBEAT_INTERVAL_MS);
  }

  private now(): number {
    return (this.deps.now ?? (() => Date.now()))();
  }

  private resetBaselines(): void {
    const now = this.now();
    this.lastTickAt = now;
    for (const state of this.states.values()) {
      state.lastPongAt = now;
    }
  }

  private stateFor(id: string): TargetState {
    let state = this.states.get(id);
    if (!state) {
      state = { lastPongAt: this.now(), flagged: false };
      this.states.set(id, state);
    }
    return state;
  }

  private subscribe(state: TargetState, webview: vscode.Webview) {
    if (state.subscribed === webview) return;
    // The sidebar can be resolved again with a new webview; the old
    // subscription would otherwise live as long as the window.
    state.disposeSubscription?.();
    const subscription = webview.onDidReceiveMessage((message: any) => {
      if (message?.messageType !== CUKII_HEARTBEAT_MESSAGE_TYPE) return;
      state.lastPongAt = this.now();
      state.flagged = false;
    });
    state.subscribed = webview;
    state.disposeSubscription = () => subscription.dispose();
  }

  tick(): void {
    if (this.disposed) return;
    const now = this.now();
    // Machine sleep or a host stall: the gap itself is not evidence of a
    // frozen webview, so treat the wake-up moment as a fresh baseline.
    if (now - this.lastTickAt > HOST_STALL_MS) {
      this.lastTickAt = now;
      this.resetBaselines();
      return;
    }
    this.lastTickAt = now;
    if (this.deps.windowFocused && !this.deps.windowFocused()) return;

    let targets: CukiiHeartbeatTarget[];
    try {
      targets = this.deps.targets();
    } catch {
      return;
    }
    const newlyFlagged: CukiiHeartbeatTarget[] = [];
    const liveIds = new Set<string>();
    for (const target of targets) {
      liveIds.add(target.id);
      const state = this.stateFor(target.id);
      try {
        const webview = target.webview();
        if (!webview || !target.visible()) {
          // Hidden panels keep no guarantee of timely timers; judge only
          // what the owner can actually see.
          state.lastPongAt = now;
          state.flagged = false;
          continue;
        }
        this.subscribe(state, webview);
        webview.postMessage({
          messageType: CUKII_HEARTBEAT_MESSAGE_TYPE,
          data: undefined,
          messageId: uuidv4(),
        });
      } catch {
        // A tab disposed between listing and probing throws on access; it
        // must not stop the watch over every other surface.
        state.lastPongAt = now;
        continue;
      }
      if (!state.flagged && now - state.lastPongAt > CUKII_HEARTBEAT_TIMEOUT_MS) {
        state.flagged = true;
        newlyFlagged.push(target);
      }
    }
    for (const [id, state] of [...this.states]) {
      if (!liveIds.has(id)) {
        state.disposeSubscription?.();
        this.states.delete(id);
      }
    }
    if (newlyFlagged.length > 0) this.notify(newlyFlagged);
  }

  private notify(targets: CukiiHeartbeatTarget[]): void {
    const labels = targets.map((target) => `"${target.label}"`).join(", ");
    const message =
      `Cukii stopped responding: ${labels} ${
        targets.length === 1 ? "has" : "have"
      } not answered for ${Math.round(
        CUKII_HEARTBEAT_TIMEOUT_MS / 1000,
      )} s, the page inside VS Code is frozen. Reload the window. ` +
      "If Cukii stays blank after the reload, quit VS Code completely and start it again: a frozen page process can outlive a window reload.";
    void this.deps
      .showWarning(message, CUKII_HEARTBEAT_RELOAD_WINDOW)
      .then((choice) => {
        if (choice === CUKII_HEARTBEAT_RELOAD_WINDOW) {
          void this.deps.executeCommand("workbench.action.reloadWindow");
        }
      });
  }

  dispose(): void {
    this.disposed = true;
    const clearTimer =
      this.deps.clearTimer ?? ((handle: unknown) => clearInterval(handle as any));
    clearTimer(this.timer);
    this.focusSubscription?.dispose();
    for (const state of this.states.values()) state.disposeSubscription?.();
    this.states.clear();
  }
}

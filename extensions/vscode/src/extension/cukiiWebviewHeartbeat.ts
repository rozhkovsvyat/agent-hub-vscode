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
 * Recovery is a window reload, never a panel reload: the webviews share one
 * renderer process, so a hung page freezes every Cukii surface at once and
 * fresh HTML is delivered into that same hung process. Measured 06.10 on an
 * isolated VS Code with a busy-looping sidebar: new HTML left it hung, and the
 * hung process even outlived a window reload (blank Cukii after it) until it
 * was killed. Hence the second step in the message.
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
  onWindowFocusChange?: (listener: (focused: boolean) => void) => void;
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

export class CukiiWebviewHeartbeat {
  private readonly states = new Map<string, TargetState>();
  private readonly subscribed = new WeakSet<object>();
  private readonly disposables: (() => void)[] = [];
  private readonly timer: unknown;
  private lastTickAt: number;
  private disposed = false;

  constructor(private readonly deps: CukiiHeartbeatDeps) {
    const now = this.now();
    this.lastTickAt = now;
    for (const target of this.deps.targets()) {
      this.states.set(target.id, { lastPongAt: now, flagged: false });
    }
    this.deps.onWindowFocusChange?.((focused) => {
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

  private subscribe(target: CukiiHeartbeatTarget, webview: vscode.Webview) {
    if (this.subscribed.has(webview)) return;
    this.subscribed.add(webview);
    const subscription = webview.onDidReceiveMessage((message: any) => {
      if (message?.messageType !== CUKII_HEARTBEAT_MESSAGE_TYPE) return;
      const state = this.states.get(target.id);
      if (!state) return;
      state.lastPongAt = this.now();
      state.flagged = false;
    });
    const state = this.stateFor(target.id);
    state.subscribed = webview;
    state.disposeSubscription = () => subscription.dispose();
    this.disposables.push(state.disposeSubscription);
  }

  tick(): void {
    if (this.disposed) return;
    const now = this.now();
    // Machine sleep or a long host stall: the gap itself is not evidence of
    // a frozen webview, so treat the wake-up moment as a fresh baseline.
    if (now - this.lastTickAt > CUKII_HEARTBEAT_INTERVAL_MS * 3) {
      this.lastTickAt = now;
      this.resetBaselines();
      return;
    }
    this.lastTickAt = now;
    if (this.deps.windowFocused && !this.deps.windowFocused()) return;

    const newlyFlagged: CukiiHeartbeatTarget[] = [];
    const liveIds = new Set<string>();
    for (const target of this.deps.targets()) {
      liveIds.add(target.id);
      const state = this.stateFor(target.id);
      const webview = target.webview();
      if (!webview || !target.visible()) {
        // Hidden panels keep no guarantee of timely timers; judge only what
        // the owner can actually see.
        state.lastPongAt = now;
        state.flagged = false;
        continue;
      }
      this.subscribe(target, webview);
      webview.postMessage({
        messageType: CUKII_HEARTBEAT_MESSAGE_TYPE,
        data: undefined,
        messageId: uuidv4(),
      });
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
    for (const dispose of this.disposables) dispose();
    this.disposables.length = 0;
    this.states.clear();
  }
}

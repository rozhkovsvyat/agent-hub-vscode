import fs from "node:fs";
import path from "node:path";

import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";

import {
  CUKII_HEARTBEAT_RELOAD_WINDOW,
  CUKII_HEARTBEAT_INTERVAL_MS,
  CUKII_HEARTBEAT_MESSAGE_TYPE,
  CUKII_HEARTBEAT_TIMEOUT_MS,
  CukiiHeartbeatTarget,
  CukiiWebviewHeartbeat,
} from "./cukiiWebviewHeartbeat";

interface FakeWebview {
  posted: any[];
  html: string;
  postMessage(message: any): void;
  onDidReceiveMessage(fn: (message: any) => void): { dispose(): void };
  receive(message: any): void;
  listenerCount(): number;
}

function fakeWebview(): FakeWebview {
  const listeners: ((message: any) => void)[] = [];
  return {
    posted: [],
    html: "<html>panel</html>",
    postMessage(message) {
      this.posted.push(message);
    },
    onDidReceiveMessage(fn) {
      listeners.push(fn);
      return {
        dispose: () => {
          const at = listeners.indexOf(fn);
          if (at >= 0) listeners.splice(at, 1);
        },
      };
    },
    receive(message) {
      for (const fn of [...listeners]) fn(message);
    },
    listenerCount: () => listeners.length,
  };
}

interface Harness {
  heartbeat: CukiiWebviewHeartbeat;
  webviews: FakeWebview[];
  warnings: { message: string; actions: string[]; choose(choice?: string): void }[];
  commands: string[];
  visible: { current: boolean };
  focused: { current: boolean };
  focusListenerDisposed: () => boolean;
  refocus(): void;
  advance(ticks: number): void;
  jump(ms: number): void;
}

function setup(webviewCount = 1): Harness {
  let now = 1_700_000_000_000;
  const webviews = Array.from({ length: webviewCount }, () => fakeWebview());
  const warnings: Harness["warnings"] = [];
  const commands: string[] = [];
  const visible = { current: true };
  const focused = { current: true };
  let focusListener: ((focused: boolean) => void) | undefined;
  let focusListenerDisposed = false;

  const heartbeat = new CukiiWebviewHeartbeat({
    targets: (): CukiiHeartbeatTarget[] =>
      webviews.map((webview, index) => ({
        id: `panel-${index}`,
        label: `panel-${index}`,
        webview: () => webview as unknown as vscode.Webview,
        visible: () => visible.current,
      })),
    now: () => now,
    setTimer: () => 0,
    clearTimer: () => {},
    windowFocused: () => focused.current,
    onWindowFocusChange: (listener) => {
      focusListener = listener;
      return {
        dispose: () => {
          focusListenerDisposed = true;
        },
      };
    },
    showWarning: (message, ...actions) => {
      let choose!: (choice?: string) => void;
      const answered = new Promise<string | undefined>((resolve) => {
        choose = resolve;
      });
      warnings.push({ message, actions, choose });
      return answered;
    },
    executeCommand: async (command) => {
      commands.push(command);
    },
  });

  return {
    heartbeat,
    webviews,
    warnings,
    commands,
    visible,
    focused,
    focusListenerDisposed: () => focusListenerDisposed,
    refocus: () => {
      focused.current = true;
      focusListener?.(true);
    },
    advance: (ticks) => {
      for (let i = 0; i < ticks; i++) {
        now += CUKII_HEARTBEAT_INTERVAL_MS;
        heartbeat.tick();
      }
    },
    jump: (ms) => {
      now += ms;
      heartbeat.tick();
    },
  };
}

const pong = { messageType: CUKII_HEARTBEAT_MESSAGE_TYPE, data: { pong: 1 } };

describe("CukiiWebviewHeartbeat", () => {
  it("stays quiet while the webview answers every ping", () => {
    const harness = setup();
    for (let i = 0; i < 8; i++) {
      harness.advance(1);
      harness.webviews[0].receive(pong);
    }
    expect(harness.webviews[0].posted).toHaveLength(8);
    expect(harness.warnings).toHaveLength(0);
  });

  it("flags a visible panel whose pongs stop, exactly once", () => {
    const harness = setup();
    // 60 s of silence: past the 45 s timeout, inside one watchdog episode.
    harness.advance(4);
    expect(harness.warnings).toHaveLength(1);
    expect(harness.warnings[0].message).toContain("panel-0");
    harness.advance(8);
    expect(harness.warnings).toHaveLength(1);
  });

  it("offers only a window reload and names the full restart behind it", () => {
    // A panel reload was measured useless: fresh HTML lands in the same hung
    // renderer, and that renderer can even outlive the window reload.
    const harness = setup();
    harness.advance(4);
    expect(harness.warnings[0].actions).toEqual([CUKII_HEARTBEAT_RELOAD_WINDOW]);
    expect(harness.warnings[0].message).toMatch(
      /stays blank after the reload, quit VS Code completely/,
    );
  });

  it("asks VS Code to reload the window when the owner picks the action", async () => {
    const harness = setup();
    harness.advance(4);
    harness.warnings[0].choose(CUKII_HEARTBEAT_RELOAD_WINDOW);
    await Promise.resolve();
    expect(harness.commands).toEqual(["workbench.action.reloadWindow"]);
  });

  it("does nothing when the owner dismisses the warning", async () => {
    const harness = setup();
    harness.advance(4);
    harness.warnings[0].choose(undefined);
    await Promise.resolve();
    expect(harness.commands).toHaveLength(0);
  });

  it("re-arms the watchdog when a revived webview pongs again", () => {
    const harness = setup();
    harness.advance(4);
    expect(harness.warnings).toHaveLength(1);
    harness.webviews[0].receive(pong);
    for (let i = 0; i < 4; i++) {
      harness.advance(1);
      harness.webviews[0].receive(pong);
    }
    expect(harness.warnings).toHaveLength(1);
    // Dead again: the recovered panel must be watchable, not silently waived.
    harness.advance(4);
    expect(harness.warnings).toHaveLength(2);
  });

  it("never judges a hidden panel", () => {
    const harness = setup();
    harness.visible.current = false;
    harness.advance(12);
    expect(harness.webviews[0].posted).toHaveLength(0);
    expect(harness.warnings).toHaveLength(0);
  });

  it("pauses while the VS Code window is unfocused and resumes on refocus", () => {
    const harness = setup();
    harness.focused.current = false;
    harness.advance(12);
    expect(harness.warnings).toHaveLength(0);
    harness.refocus();
    // The refocus itself is a fresh baseline: the unfocused stretch must not
    // count as silence, so the flag lands a full timeout after the return.
    harness.advance(3);
    expect(harness.warnings).toHaveLength(0);
    harness.advance(1);
    expect(harness.warnings).toHaveLength(1);
  });

  it("treats a sleep gap as a fresh baseline instead of a freeze", () => {
    const harness = setup();
    harness.advance(1);
    // The laptop slept: the next tick lands ten minutes later. Judging that
    // hole would accuse every panel on every wake-up.
    harness.jump(10 * 60_000);
    harness.advance(1);
    expect(harness.warnings).toHaveLength(0);
    // Still dead after the wake: detection resumes from the fresh baseline.
    harness.advance(4);
    expect(harness.warnings).toHaveLength(1);
  });

  it("collapses a simultaneous multi-panel freeze into one warning", () => {
    const harness = setup(2);
    harness.advance(4);
    expect(harness.warnings).toHaveLength(1);
    expect(harness.warnings[0].message).toContain("panel-0");
    expect(harness.warnings[0].message).toContain("panel-1");
    expect(harness.warnings[0].actions).toEqual([CUKII_HEARTBEAT_RELOAD_WINDOW]);
  });

  it("does not blame a live page for the host's own stall", () => {
    // Review of 06.10: the host froze for 35 s right after a ping, so the
    // pong was still queued behind the late tick that judged it.
    const harness = setup();
    harness.advance(1);
    harness.jump(35_000);
    expect(harness.warnings).toHaveLength(0);
    // A page that really stays silent is still caught afterwards.
    harness.advance(4);
    expect(harness.warnings).toHaveLength(1);
  });

  it("releases the subscription of a closed tab", () => {
    const harness = setup(2);
    harness.advance(1);
    const closed = harness.webviews.pop()!;
    expect(closed.listenerCount()).toBe(1);
    harness.advance(1);
    expect(closed.listenerCount()).toBe(0);
  });

  it("moves to a re-resolved sidebar webview and drops the old one", () => {
    const harness = setup();
    harness.advance(1);
    const old = harness.webviews[0];
    harness.webviews[0] = fakeWebview();
    harness.advance(1);
    expect(old.listenerCount()).toBe(0);
    expect(harness.webviews[0].listenerCount()).toBe(1);
  });

  it("releases every subscription and the focus listener on dispose", () => {
    const harness = setup(2);
    harness.advance(1);
    harness.heartbeat.dispose();
    expect(harness.webviews.map((webview) => webview.listenerCount())).toEqual([
      0, 0,
    ]);
    expect(harness.focusListenerDisposed()).toBe(true);
  });

  it("keeps watching the other surfaces when one tab throws", () => {
    let now = 0;
    const warnings: string[] = [];
    const frozen = fakeWebview();
    const heartbeat = new CukiiWebviewHeartbeat({
      targets: () => [
        {
          id: "disposed",
          label: "disposed",
          webview: () => {
            throw new Error("Webview is disposed");
          },
          visible: () => true,
        },
        {
          id: "frozen",
          label: "frozen",
          webview: () => frozen as unknown as vscode.Webview,
          visible: () => true,
        },
      ],
      now: () => now,
      setTimer: () => 0,
      clearTimer: () => {},
      showWarning: async (message) => {
        warnings.push(message);
        return undefined;
      },
      executeCommand: async () => undefined,
    });
    for (let i = 0; i < 4; i++) {
      now += CUKII_HEARTBEAT_INTERVAL_MS;
      heartbeat.tick();
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"frozen"');
    expect(warnings[0]).not.toContain('"disposed"');
  });

  it("keeps the detection window at three missed pings", () => {
    expect(CUKII_HEARTBEAT_TIMEOUT_MS).toBe(CUKII_HEARTBEAT_INTERVAL_MS * 3);
  });
});

describe("heartbeat wiring", () => {
  it("watches the sidebar and every chat tab from the extension", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "VsCodeExtension.ts"),
      "utf8",
    );
    const wiring = source.slice(source.indexOf("new CukiiWebviewHeartbeat("));
    expect(wiring).toContain('id: "sidebar"');
    expect(wiring).toContain("cukiiPanelRegistry.values()");
    expect(wiring).toContain("vscode.window.state.focused");
    expect(source).toContain("cukiiWebviewHeartbeat.dispose()");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const state = vi.hoisted(() => ({
  commands: new Map<string, (...args: any[]) => any>(),
  createWebviewPanel: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
  commands: {
    executeCommand: state.executeCommand,
    registerCommand: vi.fn(
      (name: string, callback: (...args: any[]) => any) => {
        state.commands.set(name, callback);
        return { dispose: vi.fn() };
      },
    ),
  },
  window: {
    createWebviewPanel: state.createWebviewPanel,
    registerWebviewPanelSerializer: vi.fn(() => ({ dispose: vi.fn() })),
  },
  extensions: {
    getExtension: vi.fn(() => ({ extensionUri: {} })),
  },
  Uri: { joinPath: vi.fn() },
  ViewColumn: { Beside: 2 },
}));

import { registerAllCommands } from "./commands";
import {
  CUKII_BLANK_PANEL_TITLE,
  cukiiPanelRegistry,
} from "./cukiiPanelRegistry";

function panel() {
  return {
    title: "",
    iconPath: undefined,
    webview: { html: "" },
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidChangeViewState: vi.fn(),
    onDidDispose: vi.fn(),
  };
}

function register(core: { invoke: ReturnType<typeof vi.fn> }) {
  const sidebar = {
    webviewProtocol: {
      cloneHandlers: vi.fn(() => ({ on: vi.fn(), dispose: vi.fn() })),
      request: vi.fn(),
      send: vi.fn(),
    },
    getSidebarContent: vi.fn(() => "<html />"),
  };
  const context = { subscriptions: [] as { dispose: () => void }[] };
  registerAllCommands(
    context as any,
    context as any,
    {} as any,
    sidebar as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    core as any,
    {} as any,
  );
  return sidebar;
}

describe("saved Cukii sidebar session opening", () => {
  beforeEach(() => {
    state.commands.clear();
    state.createWebviewPanel.mockReset();
    state.executeCommand.mockReset();
    for (const entry of cukiiPanelRegistry.values()) {
      cukiiPanelRegistry.remove(entry.id);
    }
  });

  it("keeps the legacy history command hidden and redirects it to the session navigator", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"),
    );
    expect(manifest.contributes.commands).not.toContainEqual(
      expect.objectContaining({ command: "continue.viewHistory" }),
    );

    const sidebar = register({ invoke: vi.fn() });

    state.commands.get("continue.viewHistory")!();

    expect(state.executeCommand).toHaveBeenCalledWith(
      "continue.continueGUIView.focus",
    );
    expect(state.executeCommand).not.toHaveBeenCalledWith(
      "continue.navigateTo",
      "/history",
      expect.anything(),
    );
    expect(sidebar.webviewProtocol.request).not.toHaveBeenCalled();
  });

  it.each([
    "/History/",
    "/history?source=command#old",
    "history/",
    "https://cukii.test/HISTORY/?source=command#old",
    "vscode-webview://panel/History/#old",
  ])("redirects the legacy route variant %s without touching chat", (route) => {
    const sidebar = register({ invoke: vi.fn() });

    state.commands.get("continue.navigateTo")!(route, true);

    expect(state.executeCommand).toHaveBeenCalledWith(
      "continue.continueGUIView.focus",
    );
    expect(sidebar.webviewProtocol.request).not.toHaveBeenCalled();
  });

  /**
   * Opening a session must cost an index lookup, never a body load. The body
   * load also starts the SessionStart lifecycle hooks, and because that start
   * is idempotent per session it made the webview's own load a no-op — the
   * whole hook cost was paid before the tab existed, on a blank screen
   * (measured: 7.9s of a 10.5s open on the installed 2.0.103).
   */
  function metadataCore(
    rows: Array<{ sessionId: string; title: string; messageCount: number }>,
  ) {
    return {
      invoke: vi.fn((command: string) =>
        command === "history/list"
          ? Promise.resolve(rows)
          : Promise.resolve(undefined),
      ),
    };
  }

  it("opens a nonempty saved sidebar session from the index, without loading its body", async () => {
    const created = panel();
    state.createWebviewPanel.mockReturnValue(created);
    const core = metadataCore([
      {
        sessionId: "saved-session",
        title: "Saved sidebar chat",
        messageCount: 2,
      },
    ]);
    register(core);
    const open = state.commands.get("continue.openInNewWindow")!;

    await open({ sessionId: "saved-session" });

    // 🔴 The limit is asserted, not incidental: `history/list` defaults to the
    // 100 newest sessions, so without it the 101st row in the navigator would
    // find no index entry and its click would become a silent no-op.
    expect(core.invoke).toHaveBeenCalledWith("history/list", {
      limit: 1_000_000,
    });
    // 🔴 The regression this pins: a body load here costs seconds of blank
    // screen and makes the webview's own load a no-op.
    expect(core.invoke).not.toHaveBeenCalledWith(
      "history/load",
      expect.anything(),
    );
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(created.title).toBe("Saved sidebar chat");
  });

  it("does not create a blank panel for a session the index reports as empty", async () => {
    const core = metadataCore([
      { sessionId: "empty-session", title: "", messageCount: 0 },
    ]);
    register(core);

    await expect(
      state.commands.get("continue.openInNewWindow")!({
        sessionId: "empty-session",
      }),
    ).resolves.toBeUndefined();
    expect(state.createWebviewPanel).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL: a record that does not state a count is still opened", async () => {
    // 🔴 `messageCount` is optional on the metadata type and counts ASSISTANT
    // messages only. Coalescing a missing field to zero would silently refuse
    // to open a perfectly good session — "this record does not say" is not
    // "this session is empty". Only an explicit zero closes the door.
    const created = panel();
    state.createWebviewPanel.mockReturnValue(created);
    const core = {
      invoke: vi.fn((command: string) =>
        command === "history/list"
          ? Promise.resolve([
              { sessionId: "no-count", title: "Imported chat" },
            ] as Array<{ sessionId: string; title: string }>)
          : Promise.resolve(undefined),
      ),
    };
    register(core);

    await state.commands.get("continue.openInNewWindow")!({
      sessionId: "no-count",
    });

    expect(state.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(created.title).toBe("Imported chat");
  });

  it("deduplicates a saved sidebar session and focuses its existing tab", async () => {
    const created = panel();
    state.createWebviewPanel.mockReturnValue(created);
    const core = metadataCore([
      {
        sessionId: "saved-session",
        title: "Saved sidebar chat",
        messageCount: 2,
      },
    ]);
    register(core);
    const open = state.commands.get("continue.openInNewWindow")!;

    await open({ sessionId: "saved-session" });
    await open({ sessionId: "saved-session" });

    expect(core.invoke).toHaveBeenCalledTimes(1);
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(created.reveal).toHaveBeenCalledTimes(1);
  });

  it("focuses the matching panelId without loading or creating another tab", async () => {
    const created = panel();
    state.createWebviewPanel.mockReturnValue(created);
    const core = metadataCore([
      {
        sessionId: "saved-session",
        title: "Saved sidebar chat",
        messageCount: 2,
      },
    ]);
    register(core);
    const open = state.commands.get("continue.openInNewWindow")!;

    await open({ sessionId: "saved-session" });
    const panelId = cukiiPanelRegistry.values()[0]!.id;
    await open({ panelId, sessionId: "saved-session" });

    expect(core.invoke).toHaveBeenCalledTimes(1);
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(created.reveal).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale panelId redirect the authoritative saved session", async () => {
    const stale = panel();
    const authoritative = panel();
    state.createWebviewPanel
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(authoritative);
    const core = metadataCore([
      { sessionId: "session-a", title: "Session A", messageCount: 2 },
      { sessionId: "session-b", title: "Session B", messageCount: 2 },
    ]);
    register(core);
    const open = state.commands.get("continue.openInNewWindow")!;

    await open({ sessionId: "session-a" });
    const stalePanelId = cukiiPanelRegistry.values()[0]!.id;
    await open({ panelId: stalePanelId, sessionId: "session-b" });

    expect(stale.reveal).not.toHaveBeenCalled();
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(authoritative.title).toBe("Session B");
  });

  it("creates independent blank Cukii tabs for repeated forceNew requests", async () => {
    const first = panel();
    const second = panel();
    state.createWebviewPanel
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const invoke = vi.fn();
    register({ invoke });
    const open = state.commands.get("continue.openInNewWindow")!;

    await open({ forceNew: true });
    await open({ forceNew: true });

    // No history/workspace lookup is needed, so this route is also valid in a
    // Remote-SSH extension host without a local workspace URI.
    expect(invoke).not.toHaveBeenCalled();
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(first.title).toBe(CUKII_BLANK_PANEL_TITLE);
    expect(second.title).toBe(CUKII_BLANK_PANEL_TITLE);
    const entries = cukiiPanelRegistry.values();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    expect(entries.map((entry) => entry.sessionId)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("does not create a blank panel when the session is absent from the index", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    register({ invoke });

    await expect(
      state.commands.get("continue.openInNewWindow")!({ sessionId: "missing" }),
    ).resolves.toBeUndefined();
    expect(state.createWebviewPanel).not.toHaveBeenCalled();
  });

  it("does not create a blank panel when the index lookup rejects", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    register({ invoke });

    await expect(
      state.commands.get("continue.openInNewWindow")!({ sessionId: "missing" }),
    ).resolves.toBeUndefined();
    expect(state.createWebviewPanel).not.toHaveBeenCalled();
  });
});

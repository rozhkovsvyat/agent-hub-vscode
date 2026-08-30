import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { cukiiPanelRegistry } from "./cukiiPanelRegistry";

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

  it("redirects the legacy history command to the session navigator", () => {
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

  it("opens a nonempty saved sidebar session", async () => {
    const created = panel();
    state.createWebviewPanel.mockReturnValue(created);
    const core = {
      invoke: vi.fn().mockResolvedValue({
        history: [{ role: "user", content: "saved" }],
        title: "Saved sidebar chat",
      }),
    };
    register(core);
    const open = state.commands.get("continue.openInNewWindow")!;

    await open({ sessionId: "saved-session" });

    expect(core.invoke).toHaveBeenCalledWith("history/load", {
      id: "saved-session",
    });
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(created.title).toBe("Saved sidebar chat");
  });

  it("deduplicates a saved sidebar session and focuses its existing tab", async () => {
    const created = panel();
    state.createWebviewPanel.mockReturnValue(created);
    const core = {
      invoke: vi.fn().mockResolvedValue({
        history: [{ role: "user", content: "saved" }],
        title: "Saved sidebar chat",
      }),
    };
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
    const core = {
      invoke: vi.fn().mockResolvedValue({
        history: [{ role: "user", content: "saved" }],
        title: "Saved sidebar chat",
      }),
    };
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
    const core = {
      invoke: vi.fn((_command: string, { id }: { id: string }) =>
        Promise.resolve({
          history: [{ role: "user", content: id }],
          title: id === "session-a" ? "Session A" : "Session B",
        }),
      ),
    };
    register(core);
    const open = state.commands.get("continue.openInNewWindow")!;

    await open({ sessionId: "session-a" });
    const stalePanelId = cukiiPanelRegistry.values()[0]!.id;
    await open({ panelId: stalePanelId, sessionId: "session-b" });

    expect(stale.reveal).not.toHaveBeenCalled();
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(authoritative.title).toBe("Session B");
  });

  it("does not create a blank panel when history/load is missing", async () => {
    const invoke = vi.fn().mockResolvedValue({ history: [], title: "" });
    register({ invoke });

    await expect(
      state.commands.get("continue.openInNewWindow")!({ sessionId: "missing" }),
    ).resolves.toBeUndefined();
    expect(state.createWebviewPanel).not.toHaveBeenCalled();
  });

  it("does not create a blank panel when history/load rejects", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    register({ invoke });

    await expect(
      state.commands.get("continue.openInNewWindow")!({ sessionId: "missing" }),
    ).resolves.toBeUndefined();
    expect(state.createWebviewPanel).not.toHaveBeenCalled();
  });
});

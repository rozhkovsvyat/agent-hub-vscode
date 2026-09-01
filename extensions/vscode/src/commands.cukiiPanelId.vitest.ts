import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  commands: new Map<string, (...args: any[]) => any>(),
  createWebviewPanel: vi.fn(),
  serializer: null as null | {
    deserializeWebviewPanel: (panel: unknown, state: unknown) => Promise<void>;
  },
}));

vi.mock("vscode", () => ({
  commands: {
    executeCommand: vi.fn(),
    registerCommand: vi.fn(
      (name: string, callback: (...args: any[]) => any) => {
        state.commands.set(name, callback);
        return { dispose: vi.fn() };
      },
    ),
  },
  window: {
    createWebviewPanel: state.createWebviewPanel,
    registerWebviewPanelSerializer: vi.fn(
      (_viewType: string, serializer: any) => {
        state.serializer = serializer;
        return { dispose: vi.fn() };
      },
    ),
  },
  extensions: {
    getExtension: vi.fn(() => ({ extensionUri: {} })),
  },
  Uri: { joinPath: vi.fn() },
  ViewColumn: { Beside: 2 },
}));

import {
  registerAllCommands,
  registerFullScreenPanelSerializer,
} from "./commands";
import { cukiiPanelRegistry } from "./cukiiPanelRegistry";

function panel() {
  return {
    title: "",
    iconPath: undefined,
    webview: { html: "", options: undefined },
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidChangeViewState: vi.fn(),
    onDidDispose: vi.fn(),
  };
}

function sidebar() {
  return {
    webviewProtocol: {
      cloneHandlers: vi.fn(() => ({ on: vi.fn(), dispose: vi.fn() })),
      request: vi.fn(),
      send: vi.fn(),
    },
    getSidebarContent: vi.fn(() => "<html />"),
  };
}

function registerCommands(core: { invoke: ReturnType<typeof vi.fn> }) {
  const side = sidebar();
  const context = { subscriptions: [] as { dispose: () => void }[] };
  registerAllCommands(
    context as any,
    context as any,
    {} as any,
    side as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    core as any,
    {} as any,
  );
  return side;
}

function registerSerializer() {
  const side = sidebar();
  const context = { subscriptions: [] as { dispose: () => void }[] };
  registerFullScreenPanelSerializer(
    context as any,
    context as any,
    side as any,
  );
  return side;
}

const PANEL_ID_PATTERN =
  /^cukii-panel-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

describe("Cukii panel identity", () => {
  beforeEach(() => {
    state.commands.clear();
    state.createWebviewPanel.mockReset();
    state.serializer = null;
    for (const entry of cukiiPanelRegistry.values()) {
      cukiiPanelRegistry.remove(entry.id);
    }
  });

  it("mints a unique, non-restart-colliding id for every new blank tab", async () => {
    registerCommands({ invoke: vi.fn() });
    state.createWebviewPanel.mockImplementation(() => panel());

    await state.commands.get("continue.openInNewWindow")!();
    await state.commands.get("continue.openInNewWindow")!();
    await state.commands.get("continue.openInNewWindow")!();

    const ids = cukiiPanelRegistry.values().map((entry) => entry.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      // Sequential counters restarted on every host restart and rehydrated
      // stale persisted state; random ids never match an old key.
      expect(id).toMatch(PANEL_ID_PATTERN);
    }
  });

  it("revives the persisted panel id and session on tab restore", async () => {
    registerSerializer();
    const revivedPanel = panel();
    state.createWebviewPanel.mockReturnValue(revivedPanel);

    const panelId = "cukii-panel-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    await state.serializer!.deserializeWebviewPanel(revivedPanel, {
      sessionId: "saved-session",
      title: "Restored tab",
      panelId,
    });

    const entries = cukiiPanelRegistry.values();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(panelId);
    expect(entries[0].sessionId).toBe("saved-session");
    expect(revivedPanel.title).toBe("Restored tab");
  });

  it("never trusts a hostile or malformed panel id from serializer state", async () => {
    registerSerializer();
    const revivedPanel = panel();

    const hostile = 'cukii-panel-1","evil":"x","sessionId":"forged';
    await state.serializer!.deserializeWebviewPanel(revivedPanel, {
      sessionId: "saved-session",
      title: "Restored tab",
      panelId: hostile,
    });

    const entries = cukiiPanelRegistry.values();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).not.toBe(hostile);
    expect(entries[0].id).toMatch(PANEL_ID_PATTERN);
  });
});

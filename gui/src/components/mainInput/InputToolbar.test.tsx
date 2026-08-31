import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  newSession,
  setBrokerPermissionMode,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { getElementByText, getElementByTestId } from "../../util/test/utils";
import InputToolbar from "./InputToolbar";

const canonicalCss = () =>
  readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

describe("Cukii Claude-parity input toolbar", () => {
  const props = {
    activeKey: null,
    isMainInput: true,
    isInputEmpty: true,
    onEnter: vi.fn(),
    onAddContextItem: vi.fn(),
    onFilesSelected: vi.fn(),
  };

  const originalCukiiVscode = window.cukiiVscode;

  afterEach(() => {
    cleanup();
    window.cukiiVscode = originalCukiiVscode;
  });

  const retainInitializedSession = (
    mockIdeMessenger: MockIdeMessenger,
    store: ReturnType<typeof setupStore>,
  ) => {
    mockIdeMessenger.responseHandlers["history/load"] = async () => {
      const session = store.getState().session;
      return {
        sessionId: session.id,
        title: session.title,
        workspaceDirectory: "",
        history: session.history,
        mode: session.mode,
        brokerModel: session.brokerModel,
        brokerSubagent: session.brokerSubagent,
        brokerEffort: session.brokerEffort,
        brokerSpeed: session.brokerSpeed,
        hasReasoningEnabled: session.hasReasoningEnabled,
        brokerPermissionMode: session.brokerPermissionMode,
      };
    };
  };

  const seedSavedHistory = (store: ReturnType<typeof setupStore>) => {
    const session = store.getState().session;
    store.dispatch(
      newSession({
        sessionId: session.id,
        title: session.title,
        workspaceDirectory: "",
        history: [
          {
            message: {
              role: "user",
              content: "Persist the selected broker preferences",
            },
            contextItems: [],
          },
        ],
        mode: session.mode,
        brokerModel: session.brokerModel,
        brokerSubagent: session.brokerSubagent,
        brokerEffort: session.brokerEffort,
        brokerSpeed: session.brokerSpeed,
        hasReasoningEnabled: session.hasReasoningEnabled,
        brokerPermissionMode: session.brokerPermissionMode,
      }),
    );
  };

  it("shows attach, slash, permission mode and submit controls", async () => {
    const { ideMessenger, user } = await renderWithProviders(
      <InputToolbar {...props} />,
    );
    ideMessenger.responses["cukii/pickAttachmentFiles"] = [
      { path: "D:/Docs/spec.pdf", name: "spec.pdf" },
    ];

    expect(
      document.querySelector('[data-testid="mode-select-button"]'),
    ).toBeNull();
    const attach = await getElementByTestId("cukii-attach-menu-button");
    const commands = await getElementByTestId("broker-menu-button");
    expect(attach.querySelector('svg[viewBox="0 0 20 20"]')).not.toBeNull();
    expect(commands.querySelector('svg[viewBox="0 0 20 20"]')).not.toBeNull();
    expect(await getElementByText("Bypass permissions")).toBeDefined();

    await user.click(attach);
    await user.click(await getElementByText("Upload from computer"));
    expect(props.onFilesSelected).toHaveBeenCalledWith([
      { path: "D:/Docs/spec.pdf", name: "spec.pdf" },
    ]);
    await user.click(attach);
    expect(await getElementByText("Add context")).toBeDefined();
  });

  it("opens the Cukii permission popover with exact copy and cycles with Shift+Tab", async () => {
    const { store, user } = await renderWithProviders(
      <InputToolbar {...props} />,
    );

    await user.click(await getElementByText("Bypass permissions"));
    expect(await getElementByText("Modes")).toBeDefined();
    expect(document.querySelectorAll(".cukii-permission-keycap")).toHaveLength(
      2,
    );
    expect(document.querySelector('[aria-label="Shift+Tab"]')).not.toBeNull();
    expect(
      await getElementByText(
        "Cukii will explore the code and present a plan before editing",
      ),
    ).toBeDefined();
    expect(
      await getElementByText(
        "Cukii will not ask for approval before running potentially dangerous commands",
      ),
    ).toBeDefined();

    await user.click(await getElementByTestId("cukii-permission-mode-bypass"));
    expect(store.getState().session.brokerPermissionMode).toBe("bypass");
    expect(await getElementByText("Bypass permissions")).toBeDefined();

    const composer = document.createElement("div");
    composer.contentEditable = "true";
    document.body.append(composer);
    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(store.getState().session.brokerPermissionMode).toBe("manual");
    composer.remove();

    await user.click(await getElementByText("Manual"));
    const selected = document.querySelector(".cukii-permission-mode-selected");
    expect(selected).not.toBeNull();
    expect(
      selected?.querySelector('[data-testid="cukii-permission-icon-manual"]'),
    ).not.toBeNull();
    expect(selected?.querySelector("svg")).not.toBeNull();
    expect(document.querySelector(".cukii-permission-keycap")).not.toBeNull();
  });

  it("keeps the static verified Claude route visible when live capabilities are empty", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["cukii/listPermissionCapabilities"] = [];

    await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
    });

    expect(await getElementByText("Bypass permissions")).toBeDefined();
  });

  it("lets live capabilities refine but not erase the static Claude routes", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["cukii/listPermissionCapabilities"] = [
      { vendor: "claude", supportedModes: ["plan", "bypass"] },
      { vendor: "codex", supportedModes: ["bypass"] },
    ];
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch({ type: "session/setBrokerModel", payload: "opus-5" });

    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    await user.click(await getElementByText("Bypass permissions"));
    expect(
      document.querySelector('[data-testid="cukii-permission-mode-plan"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="cukii-permission-mode-bypass"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="cukii-permission-mode-manual"]'),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="cukii-permission-mode-editAutomatically"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="cukii-permission-mode-auto"]'),
    ).not.toBeNull();
  });

  it("switches Manual to a supported mode in session state and persists the bridge preference", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const postSpy = vi.spyOn(mockIdeMessenger, "post");
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch(setBrokerPermissionMode("manual"));
    seedSavedHistory(store);
    retainInitializedSession(mockIdeMessenger, store);
    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    await user.click(await getElementByText("Manual"));
    await user.click(await getElementByText("Plan"));

    expect(store.getState().session.brokerPermissionMode).toBe("plan");
    expect(postSpy).toHaveBeenCalledWith(
      "cukii/setBrokerPreferences",
      expect.objectContaining({ brokerPermissionMode: "plan" }),
    );
  });

  it("reconciles Manual against the target model before persisting a model switch", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["cukii/listPermissionCapabilities"] = [
      { vendor: "claude", supportedModes: ["manual", "bypass"] },
      { vendor: "kimi", supportedModes: ["bypass"] },
    ];
    const postSpy = vi.spyOn(mockIdeMessenger, "post");
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch(setBrokerPermissionMode("manual"));
    seedSavedHistory(store);
    retainInitializedSession(mockIdeMessenger, store);
    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    await getElementByText("Manual");
    await user.click(await getElementByTestId("broker-menu-button"));
    await user.click(await getElementByTestId("broker-switch-model"));
    await user.click(await getElementByText("Kimi K3"));

    expect(store.getState().session.brokerModel).toBe("kimi-k3");
    expect(store.getState().session.brokerPermissionMode).toBe("bypass");
    expect(postSpy).toHaveBeenCalledWith(
      "cukii/setBrokerPreferences",
      expect.objectContaining({
        brokerModel: "kimi-k3",
        brokerPermissionMode: "bypass",
      }),
    );
  });

  it("retains a blank-tab draft while the native capability probe is pending", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["cukii/listPermissionCapabilities"] =
      () => new Promise<never>(() => {});
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch(setBrokerPermissionMode("bypass"));

    await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    expect(store.getState().session.brokerPermissionMode).toBe("bypass");
    expect(await getElementByText("Bypass permissions")).toBeDefined();
  });

  it.each(["codex-5-6-sol", "kimi-k3"] as const)(
    "shows and reconciles Bypass for %s while capability discovery is unavailable",
    async (model) => {
      const mockIdeMessenger = new MockIdeMessenger();
      mockIdeMessenger.responseHandlers["cukii/listPermissionCapabilities"] =
        () => new Promise<never>(() => {});
      const store = setupStore({ ideMessenger: mockIdeMessenger });
      store.dispatch({ type: "session/setBrokerModel", payload: model });
      store.dispatch(setBrokerPermissionMode("manual"));

      await renderWithProviders(<InputToolbar {...props} />, {
        mockIdeMessenger,
        store,
      });

      expect(await getElementByText("Bypass permissions")).toBeDefined();
      expect(store.getState().session.brokerPermissionMode).toBe("bypass");
    },
  );

  it("keeps the static Codex selector visible after a capability probe error", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["cukii/listPermissionCapabilities"] =
      async () => {
        throw new Error("capability probe failed");
      };
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch({
      type: "session/setBrokerModel",
      payload: "codex-5-6-sol",
    });

    await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    expect(await getElementByText("Bypass permissions")).toBeDefined();
  });

  it("uses the verified cold-cache Kimi fallback before storing its model switch", async () => {
    let panelState: Record<string, unknown> = {};
    window.cukiiVscode = {
      getState: () => panelState,
      setState: (nextState) => {
        panelState = nextState;
      },
    };
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["cukii/listPermissionCapabilities"] =
      () => new Promise<never>(() => {});
    const postSpy = vi.spyOn(mockIdeMessenger, "post");
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch(setBrokerPermissionMode("manual"));
    seedSavedHistory(store);
    retainInitializedSession(mockIdeMessenger, store);
    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    await user.click(await getElementByTestId("broker-menu-button"));
    await user.click(await getElementByTestId("broker-switch-model"));
    await user.click(await getElementByText("Kimi K3"));

    expect(store.getState().session.brokerModel).toBe("kimi-k3");
    expect(store.getState().session.brokerPermissionMode).toBe("bypass");
    expect(window.cukiiVscode?.getState()?.cukiiBrokerDraft).toMatchObject({
      brokerModel: "kimi-k3",
      brokerPermissionMode: "bypass",
    });
    expect(postSpy).toHaveBeenCalledWith(
      "cukii/setBrokerPreferences",
      expect.objectContaining({
        brokerModel: "kimi-k3",
        brokerPermissionMode: "bypass",
      }),
    );
  });

  it("opens the Claude-style command menu and keeps broker controls", async () => {
    const { store, user } = await renderWithProviders(
      <InputToolbar {...props} />,
    );

    await user.click(await getElementByTestId("broker-menu-button"));
    expect(await getElementByText("Clear conversation")).toBeDefined();
    const switchModel = await getElementByText("Switch model…");
    const switchModelText = switchModel.closest("button")?.textContent ?? "";
    expect(switchModelText.length).toBeGreaterThan("Switch model…".length);
    expect(switchModelText).not.toContain("·");
    expect(document.body.textContent).toContain("Thinking");
    expect(document.body.textContent).toContain("Manage accounts…");

    const effort = await getElementByTestId("cukii-effort-slider");
    effort.focus();
    await user.keyboard("{ArrowLeft}");
    expect(store.getState().session.brokerEffort).toBe("medium");
    expect(await getElementByText("(Medium)")).toBeDefined();
  });

  it("keeps the slash panel as a bounded overlay for narrow and long-label layouts", async () => {
    const { user } = await renderWithProviders(<InputToolbar {...props} />);

    await user.click(await getElementByTestId("broker-menu-button"));
    const menu = await getElementByTestId("cukii-slash-menu");
    const panel = menu.parentElement;
    expect(panel).toHaveClass("cukii-command-menu");
    expect(panel?.className).toContain("absolute");
    expect(panel?.className).not.toContain("w-[calc(100vw-38px)]");
    expect(
      menu.querySelector('[data-testid="broker-switch-model"] span'),
    ).toHaveClass("truncate");

    // Application CSS is not mounted by this jsdom harness.  Keep the
    // viewport contract explicit: the panel is capped at Claude-like 360px,
    // leaves gutters at 320px, and cannot force a horizontal document scroll.
    const css = canonicalCss();
    expect(css).toContain(".cukii-command-menu {");
    expect(css).toContain("width: min(360px, calc(100vw - 16px)) !important;");
    expect(css).toContain("max-width: calc(100vw - 16px) !important;");
    expect(css).toContain("min-width: 0 !important;");
    expect(css).toContain("@media (max-width: 420px)");
    expect(css).toContain("left: calc(-1px - 18.2vw) !important;");
  });

  it("has shared ordered command sections and removes unsupported Rewind", async () => {
    const { user } = await renderWithProviders(<InputToolbar {...props} />);
    await user.click(await getElementByTestId("broker-menu-button"));
    const menu = await getElementByTestId("cukii-slash-menu");
    const headers = [...menu.querySelectorAll("[data-command-section]")];
    expect(headers.map((header) => header.textContent)).toEqual([
      "Context",
      "Model",
    ]);
    expect(headers[0].previousElementSibling).not.toHaveAttribute(
      "data-testid",
      "cukii-command-section-divider",
    );
    const dividers = menu.querySelectorAll(
      '[data-testid="cukii-command-section-divider"]',
    );
    expect(dividers).toHaveLength(1);
    expect(dividers[0].nextElementSibling).toBe(headers[1]);
    expect(headers[0]).toHaveClass("cukii-command-section-header");
    expect(headers[1]).toHaveClass("cukii-command-section-header");
    expect(dividers[0]).toHaveClass("cukii-command-section-divider");
    expect(menu.textContent).not.toContain("Rewind");

    const filter = menu.querySelector<HTMLInputElement>(
      'input[placeholder="Filter actions..."]',
    );
    expect(filter).not.toBeNull();
    await user.type(filter!, "Rewind");
    expect(
      menu.querySelector('[data-cukii-command-action="Rewind"]'),
    ).toBeNull();
  });

  it("uses one blue active row for mouse and roving keyboard selection", async () => {
    document.documentElement.style.setProperty(
      "--vscode-menu-selectionBackground",
      "#123456",
    );
    document.documentElement.style.setProperty(
      "--vscode-menu-selectionForeground",
      "#ffffff",
    );
    document.documentElement.style.setProperty(
      "--vscode-list-activeSelectionBackground",
      "#654321",
    );
    const { user } = await renderWithProviders(<InputToolbar {...props} />);
    await user.click(await getElementByTestId("broker-menu-button"));
    const menu = await getElementByTestId("cukii-slash-menu");
    const filter = menu.querySelector<HTMLInputElement>(
      'input[placeholder="Filter actions..."]',
    )!;
    expect(menu.querySelector(".cukii-command-menu-item-active")).toBeNull();

    fireEvent.keyDown(filter, { key: "ArrowDown" });
    const first = menu.querySelector<HTMLButtonElement>(
      'button[data-cukii-command-action="Attach file"]',
    )!;
    expect(document.activeElement).toBe(first);
    expect(first).toHaveClass("cukii-command-menu-item-active");
    // The component carries the active semantic class; assert the canonical
    // stylesheet rule because this harness does not mount application CSS.
    const css = canonicalCss();
    expect(css).toContain(".cukii-command-menu-item-active,");
    expect(css).toContain(
      "background: var(--vscode-menu-selectionBackground) !important;",
    );
    expect(css).toContain(
      "color: var(--vscode-menu-selectionForeground) !important;",
    );
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toHaveAttribute(
      "data-cukii-command-action",
      "Mention file from this project",
    );

    const clear = menu.querySelector<HTMLButtonElement>(
      'button[data-cukii-command-action="Clear conversation"]',
    )!;
    fireEvent.mouseEnter(clear);
    expect(clear).toHaveClass("cukii-command-menu-item-active");
    expect(
      menu.querySelectorAll(".cukii-command-menu-item-active"),
    ).toHaveLength(1);
    expect(
      menu.querySelector('[data-cukii-command-action="Effort"]'),
    ).toBeNull();
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(
      document.querySelector('[data-testid="cukii-slash-menu"]'),
    ).toBeNull();
    document.documentElement.style.removeProperty(
      "--vscode-menu-selectionBackground",
    );
    document.documentElement.style.removeProperty(
      "--vscode-menu-selectionForeground",
    );
    document.documentElement.style.removeProperty(
      "--vscode-list-activeSelectionBackground",
    );
  });
});

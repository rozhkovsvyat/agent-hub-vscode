import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setBrokerPermissionMode } from "../../redux/slices/sessionSlice";
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

    await user.click(await getElementByText("Bypass permissions"));
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

  it("does not optimistically expose a permission mode without a verified route", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["cukii/listPermissionCapabilities"] = [];

    await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
    });

    expect(document.querySelector(".cukii-permission-button")).toBeNull();
  });

  it("shows only permission modes supported by the current model vendor", async () => {
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
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="cukii-permission-mode-editAutomatically"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="cukii-permission-mode-auto"]'),
    ).toBeNull();
  });

  it("switches Manual to a supported mode in session state and persists the bridge preference", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const postSpy = vi.spyOn(mockIdeMessenger, "post");
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch(setBrokerPermissionMode("manual"));
    store.dispatch({
      type: "session/streamUpdate",
      payload: [{ role: "user", content: "Use the chosen mode" }],
    });
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
    expect(document.querySelector(".cukii-permission-button")).toBeNull();
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

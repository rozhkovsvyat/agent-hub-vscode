import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setBrokerPermissionMode } from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { getElementByText, getElementByTestId } from "../../util/test/utils";
import InputToolbar from "./InputToolbar";

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
    expect(await getElementByText("Plan")).toBeDefined();

    await user.click(attach);
    await user.click(await getElementByText("Upload from computer"));
    expect(props.onFilesSelected).toHaveBeenCalledWith([
      { path: "D:/Docs/spec.pdf", name: "spec.pdf" },
    ]);
    await user.click(attach);
    expect(await getElementByText("Add context")).toBeDefined();
  });

  it("opens the Claude-style permission popover with exact copy and cycles with Shift+Tab", async () => {
    const { store, user } = await renderWithProviders(
      <InputToolbar {...props} />,
    );

    await user.click(await getElementByText("Plan"));
    expect(await getElementByText("Modes")).toBeDefined();
    expect(document.querySelectorAll(".cukii-permission-keycap")).toHaveLength(
      2,
    );
    expect(document.querySelector('[aria-label="Shift+Tab"]')).not.toBeNull();
    expect(
      await getElementByText(
        "Claude will explore the code and present a plan before editing",
      ),
    ).toBeDefined();
    expect(
      await getElementByText(
        "Claude will not ask for approval before running potentially dangerous commands",
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
    expect(store.getState().session.brokerPermissionMode).toBe("plan");
    composer.remove();

    await user.click(await getElementByText("Plan"));
    const selected = document.querySelector(".cukii-permission-mode-selected");
    expect(selected).toHaveClass("bg-[#0e639c]");
    expect(
      selected?.querySelector('[data-testid="cukii-permission-icon-plan"]'),
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
});

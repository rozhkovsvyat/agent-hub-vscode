import { describe, expect, it, vi } from "vitest";
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

  it("shows only attach, slash, bypass and submit controls", async () => {
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

  it("opens the Claude-style command menu and toggles bypass", async () => {
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
    expect(document.body.textContent).not.toContain(
      "Switch models when a message is flagged",
    );

    const effort = await getElementByTestId("cukii-effort-slider");
    effort.focus();
    await user.keyboard("{ArrowLeft}");
    expect(store.getState().session.brokerEffort).toBe("medium");
    expect(await getElementByText("(Medium)")).toBeDefined();
    expect(await getElementByTestId("cukii-slash-menu")).toBeDefined();

    await user.click(await getElementByTestId("cukii-thinking-toggle"));
    expect(store.getState().session.hasReasoningEnabled).toBe(false);
    expect(
      (await getElementByTestId("cukii-thinking-track")).className,
    ).not.toContain("cukii-toggle-track-on");
    expect(await getElementByTestId("cukii-slash-menu")).toBeDefined();

    await user.click(await getElementByTestId("cukii-speed-toggle"));
    expect(store.getState().session.brokerSpeed).toBe("fast");
    expect((await getElementByTestId("cukii-speed-track")).className).toContain(
      "cukii-toggle-track-on",
    );
    expect(await getElementByTestId("cukii-slash-menu")).toBeDefined();

    const filter = document.querySelector(
      'input[placeholder="Filter actions..."]',
    ) as HTMLInputElement;
    expect(filter).toBeDefined();
    await user.type(filter, "Switch model");
    expect(document.body.textContent).not.toContain("Clear conversation");

    await user.click(await getElementByText("Bypass permissions"));
    expect(store.getState().ui.allowAllPermissions).toBe(true);
  });
});

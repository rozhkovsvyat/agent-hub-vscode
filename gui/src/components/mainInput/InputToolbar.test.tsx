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
    onImageFileSelected: vi.fn(),
  };

  it("shows only attach, slash, bypass and submit controls", async () => {
    const { user } = await renderWithProviders(<InputToolbar {...props} />);

    expect(
      document.querySelector('[data-testid="mode-select-button"]'),
    ).toBeNull();
    expect(await getElementByTestId("cukii-attach-menu-button")).toBeDefined();
    expect(await getElementByTestId("broker-menu-button")).toBeDefined();
    expect(await getElementByText("Bypass permissions")).toBeDefined();

    await user.click(await getElementByTestId("cukii-attach-menu-button"));
    expect(await getElementByText("Attach image")).toBeDefined();
    expect(await getElementByText("Attach context")).toBeDefined();
  });

  it("opens the Claude-style command menu and toggles bypass", async () => {
    const { store, user } = await renderWithProviders(
      <InputToolbar {...props} />,
    );

    await user.click(await getElementByTestId("broker-menu-button"));
    expect(await getElementByText("Clear conversation")).toBeDefined();
    expect(await getElementByText("Switch model…")).toBeDefined();
    expect(await getElementByText("Thinking")).toBeDefined();

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

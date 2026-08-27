import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { renderWithProviders } from "../../util/test/render";
import { ModelPickerModal } from "./ModelPickerModal";
import { getElementByTestId, getElementByText } from "../../util/test/utils";
import { setMode } from "../../redux/slices/sessionSlice";

describe("ModelPickerModal", () => {
  it("renders vendors and models, selects a model and persists it", async () => {
    const { store, ideMessenger, user } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );
    const postSpy = vi.spyOn(ideMessenger, "post");

    await act(async () => {
      store.dispatch(setMode("broker"));
    });

    // Default selected vendor is inferred from current broker model (codex).
    await getElementByText("Codex");
    await getElementByText("5.6 Terra");

    // Switch vendor.
    await user.click(await getElementByText("Claude"));
    await getElementByText("Opus 5");

    // Select a model.
    await user.click(await getElementByText("Sonnet 5"));

    expect(store.getState().session.brokerModel).toBe("sonnet-5");
    expect(store.getState().session.brokerSubagent).toBe("auto");
    expect(postSpy).toHaveBeenCalledWith("cukii/setBrokerPreferences", {
      brokerModel: "sonnet-5",
      brokerSubagent: "auto",
      mode: "broker",
    });
  });

  it("does not select disabled models", async () => {
    const { store, user } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );

    await act(async () => {
      store.dispatch(setMode("broker"));
    });

    await user.click(await getElementByText("DeepSeek"));
    const disabledModel = await getElementByText("V4 Pro");
    expect(disabledModel).toBeDefined();

    await user.click(disabledModel);

    // Selection should not change from the default.
    expect(store.getState().session.brokerModel).toBe("codex-5-6-terra");
  });

  it("filters models with the search input", async () => {
    const { user } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );

    await user.click(await getElementByText("Claude"));
    const search = await getElementByTestId("model-picker-search");
    await user.type(search, "Opus");

    expect(await getElementByText("Opus 5")).toBeDefined();
    expect(
      document.querySelector('[data-testid="model-picker-empty"]'),
    ).toBeNull();

    await user.clear(search);
    await user.type(search, "zzz");

    expect(
      document.querySelector('[data-testid="model-picker-empty"]'),
    ).not.toBeNull();
  });

  it("clears search when switching vendor", async () => {
    const { user } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );

    const search = await getElementByTestId("model-picker-search");
    await user.type(search, "Opus");
    await user.click(await getElementByText("XAI"));

    expect((search as HTMLInputElement).value).toBe("");
    expect(await getElementByText("Grok 4.6")).toBeDefined();
  });
});

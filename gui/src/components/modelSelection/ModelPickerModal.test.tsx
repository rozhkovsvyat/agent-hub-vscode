import { describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithProviders } from "../../util/test/render";
import { ModelPickerModal } from "./ModelPickerModal";
import { getElementByText } from "../../util/test/utils";
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

    // The single Claude-style list keeps vendor headings visible.
    const vendorHeading = await getElementByText("OpenAI");
    expect(vendorHeading).toHaveClass("cursor-default", "select-none");
    await getElementByText("GPT-5.6 Terra");

    await getElementByText("Opus 5");
    await getElementByText("1M context — Best for everyday, complex tasks");

    // Select a model.
    await user.click(await getElementByText("Sonnet 5"));

    expect(store.getState().session.brokerModel).toBe("sonnet-5");
    expect(store.getState().session.brokerSubagent).toBe("auto");
    expect(postSpy).toHaveBeenCalledWith("cukii/setBrokerPreferences", {
      brokerModel: "sonnet-5",
      brokerSubagent: "auto",
      brokerEffort: "high",
      brokerSpeed: "standard",
      thinkingEnabled: true,
      brokerPermissionMode: "manual",
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

    const disabledModel = await getElementByText("V4 Pro (soon)");
    expect(disabledModel).toBeDefined();

    await user.click(disabledModel);

    // Selection should not change from the default.
    expect(store.getState().session.brokerModel).toBe("opus-5");
  });

  it("renders compact monochrome SVG milk ratings with one accessible label", async () => {
    await renderWithProviders(<ModelPickerModal onClose={vi.fn()} />);

    const rating = await screen.findByTestId("cukii-capability-rating-fable-5");
    expect(rating).toHaveAttribute(
      "aria-label",
      "Cukii capability rating: 4 of 4",
    );
    expect(rating).toHaveAttribute("title", "Cukii capability rating: 4 of 4");
    expect(
      rating.querySelectorAll('svg[data-cukii-capability-milk="true"]'),
    ).toHaveLength(4);
    expect(rating.textContent).toBe("");
    expect(rating.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });
});

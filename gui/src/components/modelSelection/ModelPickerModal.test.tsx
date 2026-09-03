import { describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithProviders } from "../../util/test/render";
import { ModelPickerModal } from "./ModelPickerModal";
import { getElementByText } from "../../util/test/utils";
import { setMode } from "../../redux/slices/sessionSlice";
import {
  setBrokerModelScope,
  setBrokerPermissionMode,
} from "../../redux/slices/sessionSlice";

describe("ModelPickerModal", () => {
  it("renders vendors and models, selects a model and persists it", async () => {
    const { store, ideMessenger, user } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );
    const postSpy = vi.spyOn(ideMessenger, "post");

    await act(async () => {
      store.dispatch(setMode("broker"));
      store.dispatch(setBrokerModelScope("all"));
    });

    // The single Claude-style list keeps vendor headings visible.
    const vendorHeading = await getElementByText("OpenAI");
    expect(vendorHeading).toHaveClass("cursor-default", "select-none");
    await getElementByText("GPT-5.6 Terra");

    await getElementByText("Opus 5");
    await getElementByText("1M • Best for everyday, complex tasks");

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
      brokerPermissionMode: "bypass",
      mode: "broker",
    });
  });

  it("reconciles stale Manual to Kimi Bypass before persisting", async () => {
    const { store, ideMessenger, user } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );
    const postSpy = vi.spyOn(ideMessenger, "post");
    await act(async () => {
      store.dispatch(setMode("broker"));
      store.dispatch(setBrokerPermissionMode("manual"));
    });

    await user.click(await getElementByText("Kimi K3"));
    expect(store.getState().session.brokerPermissionMode).toBe("bypass");
    expect(postSpy).toHaveBeenCalledWith(
      "cukii/setBrokerPreferences",
      expect.objectContaining({
        brokerModel: "kimi-k3",
        brokerPermissionMode: "bypass",
      }),
    );
  });

  it("does not select disabled models", async () => {
    const { store, user } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );

    await act(async () => {
      store.dispatch(setMode("broker"));
      store.dispatch(setBrokerModelScope("all"));
    });

    const disabledModel = await getElementByText("V4 Pro (soon)");
    expect(disabledModel).toBeDefined();

    await user.click(disabledModel);

    // Selection should not change from the default.
    expect(store.getState().session.brokerModel).toBe("qwen-3-8-max");
  });

  it("renders compact monochrome SVG milk ratings with one accessible label", async () => {
    const { store } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );

    await act(async () => {
      store.dispatch(setBrokerModelScope("all"));
    });

    const rating = await screen.findByTestId(
      "cukii-capability-rating-fable-5-1",
    );
    expect(rating).toHaveAttribute(
      "aria-label",
      "Cukii capability rating: 3 of 3",
    );
    expect(rating).toHaveAttribute("title", "Cukii capability rating: 3 of 3");
    expect(
      rating.querySelectorAll('svg[data-cukii-capability-milk="true"]'),
    ).toHaveLength(3);
    expect(rating.textContent).toBe("");
    expect(rating.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    // Non-top models carry no bottles at all.
    expect(screen.queryByTestId("cukii-capability-rating-sonnet-5")).toBeNull();
  });

  it("defaults to the Best scope and hides non-curated models", async () => {
    await renderWithProviders(<ModelPickerModal onClose={vi.fn()} />);

    // Curated routes stay visible in the default scope.
    await getElementByText("GPT-5.6 Sol");
    await getElementByText("Fable 5.1");
    await getElementByText("Kimi K3");
    // Full-catalog-only entries must not leak into Best.
    expect(screen.queryByText("Fable 5")).toBeNull();
    expect(screen.queryByText("Grok 4.5")).toBeNull();
    expect(screen.queryByText("V4 Pro (soon)")).toBeNull();
  });

  it("toggles Milky/All and keeps the choice in per-session state", async () => {
    const { store, user } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );

    expect(store.getState().session.brokerModelScope).toBe("best");
    const milkyLabel = await screen.findByTestId("cukii-scope-toggle-milky");
    expect(milkyLabel).toHaveAttribute("aria-pressed", "true");
    const milkySwitch = await screen.findByTestId("cukii-scope-switch");
    expect(milkySwitch).toHaveAttribute("aria-checked", "true");
    expect(milkySwitch.className).toContain("cukii-scope-switch-on");

    await user.click(milkySwitch);
    expect(store.getState().session.brokerModelScope).toBe("all");
    await getElementByText("Fable 5");
    await getElementByText("Grok 4.5");

    await user.click(milkyLabel);
    expect(store.getState().session.brokerModelScope).toBe("best");
    expect(screen.queryByText("Fable 5")).toBeNull();
  });

  it("keeps the Claude-style effort row as the model menu footer", async () => {
    const { store, ideMessenger, user } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );
    const postSpy = vi.spyOn(ideMessenger, "post");

    const slider = await screen.findByTestId("cukii-effort-slider");
    expect(slider.closest(".cukii-model-picker")).not.toBeNull();
    expect(slider).toHaveAttribute("aria-valuetext", "High");

    slider.focus();
    await user.keyboard("{ArrowLeft}");
    expect(store.getState().session.brokerEffort).toBe("medium");
    expect(postSpy).toHaveBeenCalledWith(
      "cukii/setBrokerPreferences",
      expect.objectContaining({ brokerEffort: "medium", mode: "broker" }),
    );
  });

  it("lists vendors alphabetically, matching account management", async () => {
    const { store } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );
    await act(async () => {
      store.dispatch(setBrokerModelScope("all"));
    });

    const headings = Array.from(
      document.querySelectorAll(".cukii-model-picker section > div:first-child"),
    ).map((node) => node.textContent);
    expect(headings).toEqual([...headings].sort((a, b) =>
      (a ?? "").localeCompare(b ?? "", "en", { sensitivity: "base" }),
    ));
    expect(headings).toContain("MoonshotAI");
  });
});

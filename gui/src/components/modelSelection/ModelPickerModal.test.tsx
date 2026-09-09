import { describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { renderWithProviders } from "../../util/test/render";
import { ModelPickerModal } from "./ModelPickerModal";
import { getElementByText } from "../../util/test/utils";
import { setMode } from "../../redux/slices/sessionSlice";
import {
  setBrokerModel,
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
      brokerAutocompact: "50",
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

  it("defaults to the Milky scope and hides non-curated models", async () => {
    await renderWithProviders(<ModelPickerModal onClose={vi.fn()} />);

    // Curated routes stay visible in the default scope.
    await getElementByText("GPT-5.6 Sol");
    await getElementByText("Fable 5.1");
    await getElementByText("Kimi K3");
    // Full-catalog-only entries must not leak into Milky.
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

  it("offers Fast in the model-pill menu only when the selected route supports it", async () => {
    const { store, ideMessenger, user } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );
    const postSpy = vi.spyOn(ideMessenger, "post");
    await act(async () => {
      store.dispatch(setBrokerModel("codex:gpt-6-astra"));
    });

    const toggle = await screen.findByTestId("cukii-model-fast-toggle");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    const effortRow = screen
      .getByTestId("cukii-effort-slider")
      .closest(".cukii-effort-menu-row");
    const autocompactRow = screen
      .getByTestId("cukii-autocompact-slider")
      .closest(".cukii-effort-menu-row");
    expect(toggle.previousElementSibling).toBe(effortRow);
    expect(effortRow?.previousElementSibling).toBe(autocompactRow);
    await user.click(toggle);
    expect(store.getState().session.brokerSpeed).toBe("fast");
    expect(postSpy).toHaveBeenCalledWith(
      "cukii/setBrokerPreferences",
      expect.objectContaining({
        brokerModel: "codex:gpt-6-astra",
        brokerSpeed: "fast",
        mode: "broker",
      }),
    );

    await act(async () => {
      store.dispatch(setBrokerModel("kimi-k3"));
    });
    expect(screen.queryByTestId("cukii-model-fast-toggle")).toBeNull();
  });

  it("lists vendors alphabetically, matching account management", async () => {
    const { store } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );
    await act(async () => {
      store.dispatch(setBrokerModelScope("all"));
    });

    const headings = Array.from(
      document.querySelectorAll(
        ".cukii-model-picker section > div:first-child",
      ),
    ).map((node) => node.textContent);
    expect(headings).toEqual(
      [...headings].sort((a, b) =>
        (a ?? "").localeCompare(b ?? "", "en", { sensitivity: "base" }),
      ),
    );
    expect(headings).toContain("MoonshotAI");
  });

  it("puts Autocompact directly above Effort in the menu footer", async () => {
    const { store, ideMessenger, user } = await renderWithProviders(
      <ModelPickerModal onClose={vi.fn()} />,
    );
    const postSpy = vi.spyOn(ideMessenger, "post");

    const autocompact = await screen.findByTestId("cukii-autocompact-slider");
    const effort = await screen.findByTestId("cukii-effort-slider");
    expect(autocompact.closest(".cukii-model-picker")).not.toBeNull();
    // Same order as the "/" menu: the setting must not move depending on
    // which surface you opened it from.
    expect(
      autocompact.compareDocumentPosition(effort) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    autocompact.focus();
    await user.keyboard("{ArrowLeft}");
    expect(store.getState().session.brokerAutocompact).toBe("25");
    expect(postSpy).toHaveBeenCalledWith(
      "cukii/setBrokerPreferences",
      expect.objectContaining({ brokerAutocompact: "25", mode: "broker" }),
    );
  });

  it("hangs the menu off the composer's top edge, not off the window", async () => {
    // The menu belongs to the composer and must start directly above it. It
    // used to live inside the `fixed inset-0` backdrop at `bottom-[86px]`,
    // which measures from the WINDOW: a 103px composer was overlapped by 17px,
    // and every extra line of input made the overlap worse. The lane is now a
    // plain `absolute` box anchored on the composer itself (`bottom: 100%` in
    // `.cukii-model-picker-lane`), the way Claude Code anchors its own menu.
    await renderWithProviders(<ModelPickerModal onClose={vi.fn()} />);
    const menu = document.querySelector(".cukii-model-picker");
    const lane = menu?.parentElement;
    const backdrop = document.querySelector(".cukii-model-picker-backdrop");

    expect(lane?.className).toContain("cukii-model-picker-lane");
    // No magic offset from the window may come back.
    expect(lane?.className).not.toContain("bottom-[");
    expect(lane?.className).not.toContain("fixed");
    // The backdrop is now a sibling click-catcher, not the panel's ancestor —
    // otherwise the viewport becomes the containing block again.
    expect(backdrop).not.toBeNull();
    expect(backdrop?.contains(menu ?? null)).toBe(false);
    // The lane spans the composer, so it must not eat the backdrop's clicks.
    expect(lane?.className).toContain("pointer-events-none");
    expect(menu?.className).toContain("pointer-events-auto");
  });
});

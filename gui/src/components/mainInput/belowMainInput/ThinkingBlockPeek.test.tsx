import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  setFocusView,
  setThinkingCollapse,
} from "../../../redux/slices/uiSlice";
import { renderWithProviders } from "../../../util/test/render";
import ThinkingBlockPeek from "./ThinkingBlockPeek";

describe("ThinkingBlockPeek", () => {
  it("expands when focus view is off and thinking collapse is open", async () => {
    const { store } = await renderWithProviders(
      <ThinkingBlockPeek
        content="Detailed reasoning"
        index={0}
        prevItem={null}
      />,
    );

    await act(async () => {
      store.dispatch(setThinkingCollapse(true));
    });

    expect(screen.getByTestId("thinking-block-peek")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Detailed reasoning")).toBeInTheDocument();
  });

  it("stays collapsed when focus view is on even if thinking collapse is open", async () => {
    const { store } = await renderWithProviders(
      <ThinkingBlockPeek
        content="Detailed reasoning"
        index={0}
        prevItem={null}
      />,
    );

    await act(async () => {
      store.dispatch(setFocusView(true));
      store.dispatch(setThinkingCollapse(true));
    });

    expect(screen.getByTestId("thinking-block-peek")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("can still expand manually when focus view is on", async () => {
    const { user, store } = await renderWithProviders(
      <ThinkingBlockPeek
        content="Detailed reasoning"
        index={0}
        prevItem={null}
      />,
    );

    await act(async () => {
      store.dispatch(setFocusView(true));
    });

    await user.click(screen.getByTestId("thinking-block-peek"));

    expect(screen.getByTestId("thinking-block-peek")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("shows a Thinking label while in progress, not the live loader", async () => {
    await renderWithProviders(
      <ThinkingBlockPeek
        content="Reasoning in progress"
        index={0}
        prevItem={null}
        inProgress
      />,
    );

    const peek = screen.getByTestId("thinking-block-peek");
    expect(peek.textContent).toMatch(/Thinking/);
    expect(peek.querySelector(".cukii-thinking-status-dot")).not.toBeNull();
    expect(peek.querySelector(".cukii-thinking-glyph")).toBeNull();
    expect(peek.querySelector(".cukii-thinking-inline")).toBeNull();
  });

  it("shows completed duration and toggles with button keyboard semantics", async () => {
    const { user } = await renderWithProviders(
      <ThinkingBlockPeek
        content="Completed reasoning"
        index={0}
        prevItem={null}
        durationMs={2_200}
      />,
    );

    const peek = screen.getByTestId("thinking-block-peek");
    expect(peek.textContent).toContain("Thought for 2s");
    expect(peek.querySelector(".cukii-thinking-status-dot")).toBeNull();
    expect(peek).toHaveAttribute("aria-expanded", "false");
    await user.click(peek);
    expect(peek).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Enter}");
    expect(peek).toHaveAttribute("aria-expanded", "false");
  });
});

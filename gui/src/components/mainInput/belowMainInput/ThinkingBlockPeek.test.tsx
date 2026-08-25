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
});

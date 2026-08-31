import { act, screen } from "@testing-library/react";
import { ChatHistoryItem } from "core";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../util/test/render";
import StepContainer from "./StepContainer";

const activeThought: ChatHistoryItem = {
  message: { role: "assistant", content: "" },
  contextItems: [],
  reasoning: { text: "Checking the active thought", startAt: 1 },
};

describe("StepContainer thinking lifecycle", () => {
  it("renders one active Thinking disclosure when a real thought is available", async () => {
    const { store } = await renderWithProviders(
      <StepContainer item={activeThought} index={0} isLast />,
    );
    await act(async () => {
      store.dispatch({ type: "session/setActive" });
    });

    const thought = screen.getByTestId("thinking-block-peek");
    expect(thought.textContent).toContain("Thinking");
    expect(thought.querySelector(".cukii-thinking-status-dot")).not.toBeNull();
    expect(screen.queryByTestId("cukii-thinking-label")).toBeNull();
  });
});

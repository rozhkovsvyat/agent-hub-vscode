import { act, screen } from "@testing-library/react";
import { ChatHistoryItem } from "core";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../util/test/render";
import ThinkingIndicator from "./ThinkingIndicator";

const emptyAssistant: ChatHistoryItem = {
  message: { role: "assistant", content: "" },
  contextItems: [],
};

describe("ThinkingIndicator", () => {
  it("shows a single grey-dot Thinking disclosure without the live loader", async () => {
    const { store, user } = await renderWithProviders(
      <ThinkingIndicator historyItem={emptyAssistant} />,
    );

    await act(async () => {
      store.dispatch({ type: "session/setActive" });
    });

    const label = screen.getByTestId("cukii-thinking-label");
    expect(label.textContent).toBe("Thinking");
    expect(label).toHaveAttribute("aria-expanded", "false");
    expect(label.querySelector(".cukii-thinking-status-dot")).not.toBeNull();
    expect(label.querySelector(".cukii-thinking-glyph")).toBeNull();
    expect(label.querySelector(".cukii-thinking-row")).toBeNull();
    await user.click(label);
    expect(label).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Thinking in progress")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(label).toHaveAttribute("aria-expanded", "false");
  });

  it("hides the label once the assistant has content", async () => {
    const { store } = await renderWithProviders(
      <ThinkingIndicator
        historyItem={{
          ...emptyAssistant,
          message: {
            ...emptyAssistant.message,
            content: "Hello",
          },
        }}
      />,
    );

    await act(async () => {
      store.dispatch({ type: "session/setActive" });
    });

    expect(screen.queryByTestId("cukii-thinking-label")).toBeNull();
  });
});

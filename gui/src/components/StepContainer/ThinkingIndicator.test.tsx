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
  it("shows a Thinking label without the live loader glyph", async () => {
    const { store } = await renderWithProviders(
      <ThinkingIndicator historyItem={emptyAssistant} />,
    );

    await act(async () => {
      store.dispatch({ type: "session/setActive" });
    });

    const label = screen.getByTestId("cukii-thinking-label");
    expect(label.textContent).toBe("Thinking...");
    expect(label.querySelector(".cukii-thinking-glyph")).toBeNull();
    expect(label.querySelector(".cukii-thinking-row")).toBeNull();
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

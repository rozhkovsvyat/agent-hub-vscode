import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { renderWithProviders } from "../../util/test/render";
import { QueuedMessageChip } from "./QueuedMessageChip";

describe("QueuedMessageChip", () => {
  it("renders the queued preview and can be dismissed", async () => {
    const empty = getEmptyRootState();
    const store = createMockStore({
      session: {
        ...empty.session,
        isStreaming: true,
        queuedMessage: {
          editorState: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "follow-up" }],
              },
            ],
          },
          modifiers: { useCodebase: false, noContext: true },
          preview: "follow-up",
        },
      },
    });

    const { user } = await renderWithProviders(<QueuedMessageChip />, {
      store: store as any,
    });

    expect(screen.getByTestId("queued-message-chip")).toHaveTextContent(
      "В очереди",
    );
    expect(screen.getByTestId("queued-message-chip")).toHaveTextContent(
      "follow-up",
    );

    await user.click(screen.getByLabelText("Убрать из очереди"));
    expect(
      (store.getState() as { session: { queuedMessage?: unknown } }).session
        .queuedMessage,
    ).toBeUndefined();
  });
});

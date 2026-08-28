import { act } from "@testing-library/react";
import { vi } from "vitest";
import { renderWithProviders } from "../../../util/test/render";
import { Chat, INITIAL_TRANSCRIPT_WINDOW } from "../Chat";
import {
  newSession,
  setIsSessionLoading,
} from "../../../redux/slices/sessionSlice";

const stepRenderSpy = vi.hoisted(() => vi.fn());
vi.mock("../../../components/StepContainer", () => ({
  default: ({
    item,
  }: {
    item: { message: { id: string; content: string } };
  }) => {
    stepRenderSpy(item.message.id);
    return <div>{item.message.content}</div>;
  },
}));

describe("Cukii saved-session loading", () => {
  it("shows only the centered Loading state while history is being restored", async () => {
    const { store, container } = await renderWithProviders(<Chat />);
    await act(async () => {
      store.dispatch(setIsSessionLoading(true));
    });

    expect(
      container.querySelector('[data-testid="cukii-session-loading"]')
        ?.textContent,
    ).toBe("Loading…");
    expect(
      container.querySelector('[data-testid="cukii-session-loading"]'),
    ).toHaveAttribute("role", "status");
    expect(
      container.querySelector('[data-testid="cukii-crumbs"]'),
    ).toHaveAttribute("aria-hidden", "true");
    expect(
      container.querySelector(
        '[data-testid="continue-input-box-main-editor-input"]',
      ),
    ).toBeNull();
  });

  it("never invokes old transcript rows on first render and loads one earlier batch", async () => {
    const { store, container, user } = await renderWithProviders(<Chat />);
    const history = Array.from(
      { length: INITIAL_TRANSCRIPT_WINDOW * 2 + 1 },
      (_, index) => ({
        message: {
          id: `assistant-${index}`,
          role: "assistant" as const,
          content: `Answer ${index}`,
        },
        contextItems: [],
      }),
    );
    stepRenderSpy.mockClear();
    await act(async () => {
      store.dispatch(
        newSession({
          sessionId: "large-saved-session",
          title: "Large saved session",
          workspaceDirectory: "D:/Brain/vault",
          history,
        }),
      );
    });

    expect(container.textContent).toContain("Load earlier messages");
    expect(store.getState().session.history).toHaveLength(
      INITIAL_TRANSCRIPT_WINDOW * 2 + 1,
    );
    expect(stepRenderSpy).toHaveBeenCalledTimes(INITIAL_TRANSCRIPT_WINDOW);
    expect(stepRenderSpy).not.toHaveBeenCalledWith("assistant-0");
    expect(stepRenderSpy).not.toHaveBeenCalledWith("assistant-1");
    expect(container.textContent).not.toContain("Answer 0");
    expect(container.textContent).toContain(
      `Answer ${INITIAL_TRANSCRIPT_WINDOW * 2}`,
    );

    await user.click(container.querySelector(".cukii-load-earlier")!);
    expect(stepRenderSpy).toHaveBeenCalledWith("assistant-1");
    expect(store.getState().session.history).toHaveLength(
      INITIAL_TRANSCRIPT_WINDOW * 2 + 1,
    );
  });
});

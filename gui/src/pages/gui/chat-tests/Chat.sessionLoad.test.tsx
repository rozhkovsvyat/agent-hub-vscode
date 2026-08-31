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

// React may reconcile an unchanged mocked child more than once while providers
// settle. The production child is memoized; this mock intentionally is not, so
// assert the bounded visible IDs rather than a renderer-internal raw call count.
const MAX_RECONCILIATION_PASSES_PER_PHASE = 3;

function renderedStepIds() {
  return stepRenderSpy.mock.calls.map(([id]) => id as string);
}

function expectOnlyWindowRows(start: number, endExclusive: number) {
  const expectedIds = Array.from(
    { length: endExclusive - start },
    (_, index) => `assistant-${start + index}`,
  );
  const renderedIds = renderedStepIds();

  // This is the negative control: rendering a stale pre-window row changes the
  // set and fails even if the DOM happens to hide its text.
  expect(new Set(renderedIds)).toEqual(new Set(expectedIds));
  expect(renderedIds.length).toBeLessThanOrEqual(
    expectedIds.length * MAX_RECONCILIATION_PASSES_PER_PHASE,
  );
}

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
    expectOnlyWindowRows(
      INITIAL_TRANSCRIPT_WINDOW + 1,
      INITIAL_TRANSCRIPT_WINDOW * 2 + 1,
    );
    expect(container.textContent).not.toContain("Answer 0");
    expect(container.textContent).toContain(
      `Answer ${INITIAL_TRANSCRIPT_WINDOW * 2}`,
    );
    stepRenderSpy.mockClear();
    await user.click(container.querySelector(".cukii-load-earlier")!);
    expectOnlyWindowRows(1, INITIAL_TRANSCRIPT_WINDOW * 2 + 1);
    expect(container.textContent).not.toContain("Answer 0");
    expect(container.textContent).toContain("Answer 1");
    expect(store.getState().session.history).toHaveLength(
      INITIAL_TRANSCRIPT_WINDOW * 2 + 1,
    );
  });
});

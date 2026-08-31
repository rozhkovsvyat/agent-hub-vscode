import { act } from "@testing-library/react";
import { vi } from "vitest";
import { renderWithProviders } from "../../../util/test/render";
import { Chat, INITIAL_TRANSCRIPT_WINDOW } from "../Chat";
import {
  newSession,
  setActive,
  setBridgeWait,
  setInactive,
  setIsSessionLoading,
  updateHistoryItemAtIndex,
} from "../../../redux/slices/sessionSlice";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";

// Keep the production memoized StepContainer in this integration test. These
// light leaf doubles let us observe work that happens only *after* its memo
// boundary, without making the component under test a plain function mock.
const markdownRenderSpy = vi.hoisted(() => vi.fn());
const responseActionsSpy = vi.hoisted(() => vi.fn());
vi.mock("../../../components/StyledMarkdownPreview", () => ({
  default: ({ source, itemIndex }: { source: string; itemIndex: number }) => {
    markdownRenderSpy(source, itemIndex);
    return <div data-testid={`saved-row-${itemIndex}`}>{source}</div>;
  },
}));
vi.mock("../../../components/StepContainer/ResponseActions", () => ({
  default: ({ index }: { index: number }) => {
    responseActionsSpy(index);
    return <div data-testid={`response-actions-${index}`} />;
  },
}));

function renderedStepIds() {
  return markdownRenderSpy.mock.calls.map(([source]) => source as string);
}

function expectOnlyWindowRows(start: number, endExclusive: number) {
  const expectedIds = Array.from(
    { length: endExclusive - start },
    (_, index) => `assistant-${start + index}`,
  );
  const renderedIds = renderedStepIds();

  // The fixture deliberately makes markdown source equal its immutable message
  // ID. A stale pre-window item therefore changes this exact ID set only after
  // the real memoized StepContainer has rendered its markdown child.
  expect(new Set(renderedIds)).toEqual(new Set(expectedIds));
}

function expectVisibleWindowRows(
  container: HTMLElement,
  start: number,
  endExclusive: number,
) {
  const expectedIds = Array.from(
    { length: endExclusive - start },
    (_, index) => `assistant-${start + index}`,
  );
  const visibleIds = Array.from(
    container.querySelectorAll('[data-testid^="saved-row-"]'),
    (row) => row.textContent,
  );

  expect(new Set(visibleIds)).toEqual(new Set(expectedIds));
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
          content: `assistant-${index}`,
        },
        contextItems: [],
      }),
    );
    markdownRenderSpy.mockClear();
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
    expect(container.textContent).not.toContain("assistant-0");
    expect(container.textContent).toContain(
      `assistant-${INITIAL_TRANSCRIPT_WINDOW * 2}`,
    );
    markdownRenderSpy.mockClear();
    await user.click(container.querySelector(".cukii-load-earlier")!);
    // Existing rows are real React.memo instances, so only the newly inserted
    // earlier batch reaches the markdown leaf during window expansion.
    expectOnlyWindowRows(1, INITIAL_TRANSCRIPT_WINDOW + 1);
    expectVisibleWindowRows(container, 1, INITIAL_TRANSCRIPT_WINDOW * 2 + 1);
    expect(container.textContent).not.toContain("assistant-0");
    expect(container.textContent).toContain("assistant-1");
    expect(store.getState().session.history).toHaveLength(
      INITIAL_TRANSCRIPT_WINDOW * 2 + 1,
    );
  });

  it("keeps saved rows memoized for parent updates but reacts to live row inputs", async () => {
    const { store, container } = await renderWithProviders(<Chat />);
    const history = Array.from(
      { length: INITIAL_TRANSCRIPT_WINDOW * 2 + 1 },
      (_, index) => ({
        message: {
          id: `assistant-${index}`,
          role: "assistant" as const,
          // This makes the real markdown leaf report the immutable message ID.
          content: `assistant-${index}`,
        },
        contextItems: [],
      }),
    );
    const firstVisibleIndex = INITIAL_TRANSCRIPT_WINDOW + 1;
    const lastVisibleIndex = INITIAL_TRANSCRIPT_WINDOW * 2;

    await act(async () => {
      store.dispatch(
        newSession({
          sessionId: "memoized-saved-session",
          title: "Memoized saved session",
          workspaceDirectory: "D:/Brain/vault",
          history,
        }),
      );
    });
    expectOnlyWindowRows(firstVisibleIndex, lastVisibleIndex + 1);

    // Bridge receipt changes Chat itself, but no StepContainer selector or prop.
    // If the default export loses React.memo, every visible markdown leaf runs.
    markdownRenderSpy.mockClear();
    await act(async () => {
      store.dispatch(setBridgeWait({ condition: "Waiting for bridge" }));
    });
    expect(
      container.querySelector('[data-testid="cukii-waiting-receipt"]'),
    ).toBeNull();
    expect(markdownRenderSpy).not.toHaveBeenCalled();

    // Streaming is a StepContainer selector: rows must still refresh, while the
    // last completed response hides its actions during the live stream.
    await act(async () => {
      store.dispatch(setActive());
      store.dispatch(setBridgeWait({ condition: "Waiting for bridge" }));
    });
    expect(
      container.querySelector('[data-testid="cukii-waiting-receipt"]'),
    ).toHaveTextContent("Waiting for bridge");
    expect(new Set(renderedStepIds())).toEqual(
      new Set(
        Array.from(
          { length: INITIAL_TRANSCRIPT_WINDOW },
          (_, index) => `assistant-${firstVisibleIndex + index}`,
        ),
      ),
    );
    expect(
      container.querySelector(
        `[data-testid="response-actions-${lastVisibleIndex}"]`,
      ),
    ).toBeNull();

    markdownRenderSpy.mockClear();
    await act(async () => {
      store.dispatch(setInactive());
      store.dispatch(
        updateConfig({
          ...EMPTY_CONFIG,
          ui: { displayRawMarkdown: true },
        }),
      );
    });
    expect(markdownRenderSpy).not.toHaveBeenCalled();
    expect(
      container.querySelector(`[data-testid="saved-row-${firstVisibleIndex}"]`),
    ).toBeNull();
    expect(container.querySelectorAll("pre")).toHaveLength(
      INITIAL_TRANSCRIPT_WINDOW,
    );
    expect(container.textContent).toContain(`assistant-${firstVisibleIndex}`);

    await act(async () => {
      store.dispatch(updateConfig(EMPTY_CONFIG));
    });
    expectOnlyWindowRows(firstVisibleIndex, lastVisibleIndex + 1);

    // A row's successor is a selector used for response-action eligibility.
    // Updating that neighbour must re-render just the affected saved row.
    markdownRenderSpy.mockClear();
    responseActionsSpy.mockClear();
    await act(async () => {
      store.dispatch(
        updateHistoryItemAtIndex({
          index: firstVisibleIndex + 1,
          updates: {
            message: {
              id: `user-after-${firstVisibleIndex}`,
              role: "user",
              content: "Follow-up",
            },
          },
        }),
      );
    });
    expect(renderedStepIds()).toEqual([`assistant-${firstVisibleIndex}`]);
    expect(responseActionsSpy).toHaveBeenCalledWith(firstVisibleIndex);
    expect(
      container.querySelector(
        `[data-testid="response-actions-${firstVisibleIndex}"]`,
      ),
    ).not.toBeNull();
  });
});

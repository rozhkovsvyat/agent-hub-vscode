import { act, render, waitFor } from "@testing-library/react";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { CSSProperties } from "react";
import { renderWithProviders } from "../../../util/test/render";
import {
  CukiiStickyUserMessage,
  isStickyRowPinned,
  resolveStickyCollapseGeometry,
  resolveStickyNaturalHeight,
} from "../../../components/cukii/CukiiStickyUserMessage";
import { Chat } from "../Chat";

const canonicalCss = () =>
  readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

test("groups every user prompt with its response so the next sticky turn displaces it", async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "sticky-turns",
        title: "Sticky turns",
        history: [
          {
            message: { id: "u1", role: "user", content: "First prompt" },
            contextItems: [],
          },
          {
            message: { id: "a1", role: "assistant", content: "First answer" },
            contextItems: [],
          },
          {
            message: { id: "u2", role: "user", content: "Second prompt" },
            contextItems: [],
          },
          {
            message: {
              id: "a2",
              role: "assistant",
              content: "Second answer",
            },
            contextItems: [],
          },
        ],
      },
    });
  });

  const turns = container.querySelectorAll(".cukii-turn");
  expect(turns).toHaveLength(2);
  expect(turns[0].textContent).toContain("First prompt");
  expect(turns[0].textContent).toContain("First answer");
  expect(turns[0].textContent).not.toContain("Second prompt");
  expect(turns[1].textContent).toContain("Second prompt");
  expect(turns[1].textContent).toContain("Second answer");
  for (const turn of Array.from(turns)) {
    expect(turn.querySelector(".cukii-user-row--sticky")).not.toBeNull();
    expect(turn.querySelector(".cukii-user-row-flow-spacer")).toBeNull();
  }

  const css = canonicalCss();
  expect(css).toMatch(/\.cukii-user-row--sticky\s*\{[^}]*position:\s*sticky/s);
  expect(css).toMatch(/\.cukii-user-row--sticky\s*\{[^}]*top:\s*0/s);
  expect(css).toMatch(/\.cukii-transcript\s*\{[^}]*padding:\s*0 20px 40px/s);
  expect(css).toMatch(/\.cukii-transcript::before\s*\{[^}]*height:\s*20px/s);
  expect(css).toContain("padding-top: 14px");
  expect(css).toContain("padding-bottom: 12px");
  expect(css).toMatch(
    /\.cukii-user-row--sticky \.cukii-user-message\s*\{[^}]*max-width:\s*70%/s,
  );
  expect(css).toMatch(
    /\.cukii-user-row--sticky \.cukii-user-message\s*\{[^}]*width:\s*fit-content/s,
  );
  expect(css).not.toMatch(
    /\.cukii-user-row--sticky \.cukii-user-message\s*\{[^}]*width:\s*100%/s,
  );
  expect(css).not.toMatch(
    /\.cukii-user-row--sticky \.cukii-user-message[^}]*max-width:\s*none/s,
  );
  expect(css).toMatch(
    /\.cukii-user-row--group-start,[^}]*--cukii-user-row-padding-bottom:\s*0px/s,
  );
  expect(css).toMatch(
    /\.cukii-user-row--group-middle,[^}]*\.cukii-user-row--group-end[^}]*--cukii-user-row-padding-top:\s*0px/s,
  );
  // The mask moved to ::before and now paints the measured canvas rather than
  // re-declaring a surface token: `--cukii-chat-background` describes
  // html/body/#root, which a styled-component repaints before the transcript
  // ever sees it, so binding the mask to it produced a dark strip.
  const stickyRowRule = css.match(
    /\.cukii-user-row--sticky\s*\{([^}]*)\}/s,
  )?.[1];
  expect(stickyRowRule).not.toContain("linear-gradient");
  const stickyMaskRule = css.match(
    /\.cukii-user-row--sticky::before\s*\{([^}]*)\}/s,
  )?.[1];
  expect(stickyMaskRule).toContain(
    "var(--cukii-canvas, var(--cukii-chat-background))",
  );
  expect(stickyMaskRule).toContain("mask-image");
  expect(stickyMaskRule).not.toContain("--vscode-sideBar-background");
});

test("folds line by line as scroll is consumed past the pin", () => {
  const fullHeight = 140;
  const collapseDistance = fullHeight - 20;

  // The moment the row touches the sticky edge nothing has folded yet: the
  // capsule first pins at its full height.
  expect(
    resolveStickyCollapseGeometry({ fullHeight, consumedScroll: 0 }),
  ).toEqual({ progress: 0, visibleHeight: 140 });

  // Scrolling back above the pin point cannot produce negative progress.
  expect(
    resolveStickyCollapseGeometry({ fullHeight, consumedScroll: -15 }),
  ).toEqual({ progress: 0, visibleHeight: 140 });

  // Every consumed scroll pixel removes exactly one painted pixel before the
  // terminal one-line state.
  expect(
    resolveStickyCollapseGeometry({ fullHeight, consumedScroll: 60 }),
  ).toEqual({ progress: 0.5, visibleHeight: 80 });
  expect(
    resolveStickyCollapseGeometry({ fullHeight, consumedScroll: 30 }),
  ).toEqual({ progress: 0.25, visibleHeight: 110 });

  // The fold bottoms out at one line and never shrinks past it, however far
  // the transcript scrolls on.
  expect(
    resolveStickyCollapseGeometry({
      fullHeight,
      consumedScroll: collapseDistance,
    }),
  ).toEqual({ progress: 1, visibleHeight: 20 });
  expect(
    resolveStickyCollapseGeometry({
      fullHeight,
      consumedScroll: collapseDistance + 500,
    }),
  ).toEqual({ progress: 1, visibleHeight: 20 });

  // A one-line message has no fold distance and keeps its geometry at any
  // scroll position.
  expect(
    resolveStickyCollapseGeometry({ fullHeight: 20, consumedScroll: 100 }),
  ).toEqual({ progress: 0, visibleHeight: 20 });

  // Attachment strips are content height, not a special exception: once the
  // combined capsule is taller than one line it follows the same fold rule.
  expect(
    resolveStickyCollapseGeometry({ fullHeight: 60, consumedScroll: 40 }),
  ).toEqual({ progress: 1, visibleHeight: 20 });
});

test("reflows to the current expanded height but ignores the terminal 20px clip", () => {
  expect(
    resolveStickyNaturalHeight({
      measuredHeight: 449,
      previousHeight: 0,
      terminallyCollapsed: false,
    }),
  ).toBe(449);
  // The owner widened the window while the capsule was not terminally folded.
  // Historical-max logic kept 449 here and made reverse scroll overshoot to
  // 448px before jumping to the actual 332px expanded layout.
  expect(
    resolveStickyNaturalHeight({
      measuredHeight: 332,
      previousHeight: 449,
      terminallyCollapsed: false,
    }),
  ).toBe(332);
  // Once CSS has reduced the real descendant to one row, keep that fresh
  // expanded baseline until the first reverse pixel removes the terminal class.
  expect(
    resolveStickyNaturalHeight({
      measuredHeight: 20,
      previousHeight: 332,
      terminallyCollapsed: true,
    }),
  ).toBe(332);
});

test("pins a row only while its painted top sits on the sticky edge (ID-234)", () => {
  // At the edge with scroll consumed: pinned.
  expect(isStickyRowPinned({ rowTopFromScrollport: 0, scrollTop: 40 })).toBe(
    true,
  );
  // A one-pixel tolerance absorbs sub-pixel rounding at the edge.
  expect(isStickyRowPinned({ rowTopFromScrollport: 1, scrollTop: 40 })).toBe(
    true,
  );
  expect(isStickyRowPinned({ rowTopFromScrollport: 2, scrollTop: 40 })).toBe(
    false,
  );
  // Still in flow above the edge.
  expect(isStickyRowPinned({ rowTopFromScrollport: 20, scrollTop: 40 })).toBe(
    false,
  );
  // A row pushed above the edge by the next sticky turn keeps its pin, so the
  // capsule leaves the window folded instead of re-expanding on the way out.
  expect(isStickyRowPinned({ rowTopFromScrollport: -20, scrollTop: 40 })).toBe(
    true,
  );
  // At the very top of the transcript no scroll has been consumed yet: the
  // capsule rests at the edge unpinned and unfolds only once scrolling starts.
  expect(isStickyRowPinned({ rowTopFromScrollport: 0, scrollTop: 0 })).toBe(
    false,
  );
});

test("does not reserve the clipped prompt as an invisible flow gap", () => {
  const css = canonicalCss();
  expect(css).not.toContain(".cukii-user-row-flow-spacer");
  expect(css).not.toContain("--cukii-sticky-flow-spacer-height");
  expect(css).toMatch(/\.cukii-transcript\s*\{[^}]*overflow-anchor:\s*none/s);
});

test("collapses when streamed markdown becomes long after the row sticks", async () => {
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  const scrollTopDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTop",
  );
  const originalGetBoundingClientRect =
    HTMLElement.prototype.getBoundingClientRect;
  const originalMutationObserver = globalThis.MutationObserver;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const mutationCallbacks: Array<() => void> = [];
  let contentHeight = 0;
  let transcriptScrollTop = 60;
  let rowTop = 40;

  class TestMutationObserver {
    constructor(callback: MutationCallback) {
      mutationCallbacks.push(() =>
        callback([], this as unknown as MutationObserver),
      );
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList?.contains(
        "cukii-user-message-content",
      ) || (this as HTMLElement).classList?.contains("cukii-user-message-body")
        ? contentHeight
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList?.contains("cukii-transcript")
        ? transcriptScrollTop
        : 0;
    },
    set(value: number) {
      if ((this as HTMLElement).classList?.contains("cukii-transcript")) {
        transcriptScrollTop = value;
      }
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("cukii-transcript")) {
      return { top: 0, height: 500 } as DOMRect;
    }
    if (this.classList.contains("cukii-user-row--sticky")) {
      return { top: rowTop, height: contentHeight + 46 } as DOMRect;
    }
    if (
      this.classList.contains("cukii-user-message-content") ||
      this.classList.contains("cukii-user-message-body")
    ) {
      return { top: rowTop + 14, height: contentHeight } as DOMRect;
    }
    if (this.classList.contains("cukii-user-message-bubble")) {
      return { top: rowTop + 14, height: contentHeight + 20 } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
  globalThis.MutationObserver =
    TestMutationObserver as unknown as typeof MutationObserver;
  globalThis.ResizeObserver =
    TestResizeObserver as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => undefined;

  try {
    const { container } = render(
      <div className="cukii-transcript">
        <div className="cukii-user-row--sticky">
          <CukiiStickyUserMessage
            bubbleClassName="cukii-user-message-bubble"
            messageId="late-markdown"
          >
            Streamed prompt
          </CukiiStickyUserMessage>
        </div>
      </div>,
    );
    const bubble = container.querySelector(
      '[data-testid="cukii-user-bubble-late-markdown"]',
    );

    // The first layout pass sees no Markdown height yet, while the row is in
    // normal flow at scrollTop 60 + top 40 = document offset 100.
    expect(bubble).not.toHaveAttribute("data-cukii-long-prompt");

    // Streaming finishes after auto-scroll has already pinned the row. Blink's
    // sticky offset now equals the current scrollTop, so the fold origin can
    // only be adopted from here on: the capsule pins at full height and folds
    // as more scroll is consumed.
    contentHeight = 140;
    transcriptScrollTop = 220;
    rowTop = 0;
    act(() => mutationCallbacks.forEach((callback) => callback()));

    await waitFor(() =>
      expect(bubble).toHaveAttribute("data-cukii-long-prompt", "true"),
    );
    const row = bubble?.closest(".cukii-user-row--sticky");
    expect(bubble).not.toHaveClass("cukii-user-bubble--collapsed");
    expect(row?.getAttribute("data-cukii-collapse-progress")).toBe("0.0000");

    // Half the fold distance collapses exactly half the capsule...
    const transcript = container.querySelector(".cukii-transcript")!;
    transcriptScrollTop = 280;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    expect(row?.getAttribute("data-cukii-collapse-progress")).toBe("0.5000");
    expect(bubble).not.toHaveClass("cukii-user-bubble--collapsed");

    // ...and the full distance folds it to one line.
    transcriptScrollTop = 340;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    await waitFor(() =>
      expect(bubble).toHaveClass("cukii-user-bubble--collapsed"),
    );
    expect(row?.getAttribute("data-cukii-collapse-progress")).toBe("1.0000");
  } finally {
    if (scrollHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollHeight",
        scrollHeightDescriptor,
      );
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)
        .scrollHeight;
    }
    if (scrollTopDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollTop",
        scrollTopDescriptor,
      );
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)
        .scrollTop;
    }
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    globalThis.MutationObserver = originalMutationObserver;
    globalThis.ResizeObserver = originalResizeObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("collapses a restored long prompt that mounts already sticky", async () => {
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  const scrollTopDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTop",
  );
  const originalGetBoundingClientRect =
    HTMLElement.prototype.getBoundingClientRect;
  const originalMutationObserver = globalThis.MutationObserver;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const mutationCallbacks: Array<() => void> = [];
  let contentHeight = 0;
  let transcriptScrollTop = 220;

  class TestMutationObserver {
    constructor(callback: MutationCallback) {
      mutationCallbacks.push(() =>
        callback([], this as unknown as MutationObserver),
      );
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList?.contains(
        "cukii-user-message-content",
      ) || (this as HTMLElement).classList?.contains("cukii-user-message-body")
        ? contentHeight
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList?.contains("cukii-transcript")
        ? transcriptScrollTop
        : 0;
    },
    set(value: number) {
      if ((this as HTMLElement).classList?.contains("cukii-transcript")) {
        transcriptScrollTop = value;
      }
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("cukii-transcript")) {
      return { top: 0, height: 500 } as DOMRect;
    }
    if (this.classList.contains("cukii-user-row--sticky")) {
      return { top: 0, height: contentHeight + 46 } as DOMRect;
    }
    if (
      this.classList.contains("cukii-user-message-content") ||
      this.classList.contains("cukii-user-message-body")
    ) {
      return { top: 14, height: contentHeight } as DOMRect;
    }
    if (this.classList.contains("cukii-user-message-bubble")) {
      return { top: 14, height: contentHeight + 20 } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
  globalThis.MutationObserver =
    TestMutationObserver as unknown as typeof MutationObserver;
  globalThis.ResizeObserver =
    TestResizeObserver as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => undefined;

  try {
    const { container } = render(
      <div className="cukii-transcript">
        <div className="cukii-turn">
          <div className="cukii-user-row--sticky">
            <CukiiStickyUserMessage
              bubbleClassName="cukii-user-message-bubble"
              messageId="restored-at-bottom"
            >
              Restored prompt
            </CukiiStickyUserMessage>
          </div>
        </div>
      </div>,
    );
    const bubble = container.querySelector(
      '[data-testid="cukii-user-bubble-restored-at-bottom"]',
    );
    expect(bubble).not.toHaveAttribute("data-cukii-long-prompt");

    contentHeight = 140;
    act(() => mutationCallbacks.forEach((callback) => callback()));

    // Mounting already pinned adopts the current scroll position as the fold
    // origin: the capsule pins at full height and folds as scroll continues.
    await waitFor(() =>
      expect(bubble).toHaveAttribute("data-cukii-long-prompt", "true"),
    );
    const row = bubble?.closest(".cukii-user-row--sticky");
    expect(bubble).not.toHaveClass("cukii-user-bubble--collapsed");
    expect(row?.getAttribute("data-cukii-collapse-progress")).toBe("0.0000");

    const transcript = container.querySelector(".cukii-transcript")!;
    transcriptScrollTop = 340;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    await waitFor(() =>
      expect(bubble).toHaveClass("cukii-user-bubble--collapsed"),
    );
    expect(row?.getAttribute("data-cukii-collapse-progress")).toBe("1.0000");

    // Once fully folded, reverse scrolling cannot reopen the capsule. The
    // explicit chevron is the only opening control while it remains sticky.
    transcriptScrollTop = 280;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    expect(row?.getAttribute("data-cukii-collapse-progress")).toBe("1.0000");
    expect(bubble).toHaveClass("cukii-user-bubble--collapsed");
  } finally {
    if (scrollHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollHeight",
        scrollHeightDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    }
    if (scrollTopDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollTop",
        scrollTopDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
    }
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    globalThis.MutationObserver = originalMutationObserver;
    globalThis.ResizeObserver = originalResizeObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("folds a long prompt pixel by pixel past the sticky edge and keeps the fold while displaced", async () => {
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  const originalResizeObserver = globalThis.ResizeObserver;
  const resizeCallbacks: Array<() => void> = [];
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(() =>
        callback([], this as unknown as ResizeObserver),
      );
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    TestResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      const element = this as HTMLElement;
      if (element.classList?.contains("cukii-user-message-body")) return 140;
      if (!element.classList?.contains("cukii-user-message-content")) return 0;
      return element.classList.contains("cukii-user-message-content--collapsed")
        ? 20
        : 140;
    },
  });

  try {
    const { store, container, user } = await renderWithProviders(<Chat />);
    await act(async () => {
      store.dispatch({
        type: "session/newSession",
        payload: {
          sessionId: "long-sticky-prompt",
          title: "Long sticky prompt",
          history: [
            {
              message: {
                id: "long-user",
                role: "user",
                content:
                  "A long prompt that exceeds Claude's folded height. ".repeat(
                    12,
                  ),
                metadata: {
                  cukiiReaction: {
                    reactionId: "long-user-reaction",
                    emoji: "❤️",
                    reactedAt: 1_700_000_000_000,
                    source: "agent",
                  },
                },
              },
              contextItems: [],
              isSteer: true,
              steerStatus: "read",
              steerSentAt: 1_700_000_000_000,
            },
            {
              message: {
                id: "answer",
                role: "assistant",
                content: "Answer",
              },
              contextItems: [],
            },
          ],
        },
      });
    });

    const bubble = container.querySelector(
      '[data-testid="cukii-user-bubble-long-user"]',
    );
    expect(bubble).not.toHaveClass("cukii-user-bubble--collapsed");
    expect(container.querySelector('[aria-label="Show more"]')).toBeNull();
    const stableFooter = bubble?.querySelector(".cukii-user-fold-footer");
    expect(stableFooter).not.toBeNull();

    const transcript =
      container.querySelector<HTMLElement>(".cukii-transcript")!;
    const row = bubble?.closest<HTMLElement>(".cukii-user-row--sticky")!;
    expect(row.nextElementSibling).toHaveClass("cukii-assistant-row");
    const content = bubble?.querySelector<HTMLElement>(
      ".cukii-user-message-content",
    )!;
    const embeddedReaction = bubble?.querySelector(
      '[data-cukii-reaction-id="long-user-reaction"]',
    );
    expect(embeddedReaction).not.toBeNull();
    expect(content).toContainElement(embeddedReaction as HTMLElement);
    expect(embeddedReaction).toHaveAttribute(
      "data-cukii-reaction-placement",
      "embedded",
    );
    Object.defineProperty(transcript, "scrollTop", {
      configurable: true,
      value: 100,
      writable: true,
    });
    transcript.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    let rowTop = 40;
    row.getBoundingClientRect = () => ({ top: rowTop }) as DOMRect;

    // In flow the capsule paints at its natural height and exposes no fold.
    transcript.scrollTop = 60;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    expect(bubble).not.toHaveClass("cukii-user-bubble--collapsed");
    expect(row.hasAttribute("data-cukii-collapse-progress")).toBe(false);

    // Touching the sticky edge only pins the capsule: contact alone folds
    // nothing, the fold starts from zero progress.
    rowTop = 0;
    transcript.scrollTop = 100;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    expect(bubble).not.toHaveClass("cukii-user-bubble--collapsed");
    expect(row.getAttribute("data-cukii-collapse-progress")).toBe("0.0000");
    expect(
      content.style.getPropertyValue("--cukii-sticky-visible-height"),
    ).toBe("");
    // The painted sticky row remains full-height at contact; there is no
    // invisible sibling reserving the future clipped height.
    expect(container.querySelector(".cukii-user-row-flow-spacer")).toBeNull();

    // Every consumed scroll pixel removes exactly one painted pixel.
    transcript.scrollTop = 160;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    expect(row.getAttribute("data-cukii-collapse-progress")).toBe("0.5000");
    expect(content).toHaveAttribute("data-cukii-scroll-folding", "true");
    expect(
      content.style.getPropertyValue("--cukii-sticky-visible-height"),
    ).toBe("80px");
    expect(bubble).not.toHaveClass("cukii-user-bubble--collapsed");

    // ...down to one line once the whole fold distance is consumed.
    transcript.scrollTop = 220;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    await waitFor(() =>
      expect(bubble).toHaveClass("cukii-user-bubble--collapsed"),
    );
    expect(row.getAttribute("data-cukii-collapse-progress")).toBe("1.0000");
    expect(
      content.style.getPropertyValue("--cukii-sticky-visible-height"),
    ).toBe("20px");
    const clippedContent = bubble?.querySelector(
      ".cukii-user-message-content--collapsed",
    );
    const receipt = bubble?.querySelector(
      '[data-testid="cukii-message-receipt-long-user"]',
    );
    expect(clippedContent).not.toBeNull();
    expect(clippedContent?.contains(embeddedReaction ?? null)).toBe(true);
    expect(
      content.style.getPropertyValue("--cukii-sticky-visible-height"),
    ).toBe("20px");

    // A real browser emits ResizeObserver after the collapsed CSS changes
    // scrollHeight to 20. That painted height must not reclassify the immutable
    // long prompt as short and clear the fold.
    act(() => resizeCallbacks.forEach((callback) => callback()));
    await waitFor(() =>
      expect(bubble).toHaveClass("cukii-user-bubble--collapsed"),
    );
    expect(bubble).toHaveAttribute("data-cukii-long-prompt", "true");
    expect(receipt?.textContent).toBe("01:13");
    expect(clippedContent?.contains(receipt ?? null)).toBe(false);
    expect(
      receipt?.querySelector(
        '[data-testid="cukii-message-receipt-status-read"]',
      ),
    ).not.toBeNull();

    // Chromium now exposes the clipped 20px descendant as scrollHeight. A
    // second event must not reinterpret that painted height as the prompt's
    // natural height and bounce the capsule open again.
    transcript.scrollTop = 221;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    await waitFor(() =>
      expect(bubble).toHaveClass("cukii-user-bubble--collapsed"),
    );
    expect(
      content.style.getPropertyValue("--cukii-sticky-visible-height"),
    ).toBe("20px");

    // The terminal one-line state is latched. Reverse scrolling cannot reopen
    // it behind the reader's back; only the chevron changes that choice.
    transcript.scrollTop = 219;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    expect(row.getAttribute("data-cukii-collapse-progress")).toBe("1.0000");
    expect(
      content.style.getPropertyValue("--cukii-sticky-visible-height"),
    ).toBe("20px");
    expect(bubble).toHaveClass("cukii-user-bubble--collapsed");

    transcript.scrollTop = 220;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    await waitFor(() =>
      expect(bubble).toHaveClass("cukii-user-bubble--collapsed"),
    );

    const collapsedToggle = container.querySelector('[aria-label="Show more"]');
    const footer = bubble?.querySelector(".cukii-user-fold-footer");
    expect(footer).not.toBeNull();
    expect(footer).toBe(stableFooter);
    expect(collapsedToggle?.parentElement).toBe(footer);
    expect(receipt?.parentElement).toBe(footer);
    expect(footer?.firstElementChild).toBe(collapsedToggle);
    expect(footer?.lastElementChild).toBe(receipt);
    expect(collapsedToggle?.textContent).toBe("");
    expect(
      bubble?.querySelector(".cukii-user-expand-button-container"),
    ).toBeNull();
    expect(
      bubble?.querySelector(".cukii-user-collapse-button-container"),
    ).toBeNull();

    await user.click(collapsedToggle!);
    expect(bubble).toHaveClass("cukii-user-bubble--expanded");
    expect(
      bubble?.querySelector(".cukii-user-message-content--collapsed"),
    ).toBeNull();
    expect(receipt?.parentElement).toBe(footer);
    const expandedToggle = container.querySelector('[aria-label="Show less"]');
    expect(expandedToggle?.parentElement).toBe(footer);
    expect(expandedToggle?.getAttribute("aria-expanded")).toBe("true");

    await user.click(expandedToggle!);
    expect(bubble).toHaveClass("cukii-user-bubble--collapsed");
    expect(
      content.style.getPropertyValue("--cukii-sticky-visible-height"),
    ).toBe("20px");

    // The explicit Show less click above, unlike scroll-created closure,
    // latches the one-line state until the chevron opens it again.
    transcript.scrollTop = 190;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    expect(row.getAttribute("data-cukii-collapse-progress")).toBe("1.0000");
    expect(
      content.style.getPropertyValue("--cukii-sticky-visible-height"),
    ).toBe("20px");
    expect(bubble).toHaveClass("cukii-user-bubble--collapsed");

    // Scrolling forward folds the capsule back to one line...
    transcript.scrollTop = 240;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    await waitFor(() =>
      expect(bubble).toHaveClass("cukii-user-bubble--collapsed"),
    );

    // ...and the next sticky turn can push this row above the viewport. It
    // leaves folded instead of expanding into a large block on the way out.
    rowTop = -20;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    await waitFor(() =>
      expect(bubble).toHaveClass("cukii-user-bubble--collapsed"),
    );
    expect(container.querySelector('[aria-label="Show more"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Show less"]')).toBeNull();

    // Even a newer turn that arrives before the fold distance is consumed
    // pushes the old, non-expanded capsule out as one quiet row.
    rowTop = 40;
    transcript.scrollTop = 60;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    rowTop = 0;
    transcript.scrollTop = 100;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    rowTop = -2;
    transcript.scrollTop = 101;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    expect(row.getAttribute("data-cukii-collapse-progress")).toBe("1.0000");
    expect(bubble).toHaveClass("cukii-user-bubble--collapsed");

    // A capsule the reader expanded with the chevron keeps that state while
    // the next turn pushes it out: scroll never resets the user's choice, so
    // it leaves expanded — and stays expanded until the reader folds it back.
    rowTop = 0;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    await user.click(container.querySelector('[aria-label="Show more"]')!);
    expect(bubble).toHaveClass("cukii-user-bubble--expanded");
    rowTop = -30;
    transcript.scrollTop = 400;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    expect(bubble).toHaveClass("cukii-user-bubble--expanded");
    expect(bubble).not.toHaveClass("cukii-user-bubble--collapsed");
    await user.click(container.querySelector('[aria-label="Show less"]')!);
    expect(bubble).toHaveClass("cukii-user-bubble--collapsed");

    // The prompt body is text, not a control. Clicking it cannot expand the
    // displaced sticky message; only the chevron controls that state.
    await user.click(
      bubble?.querySelector(".cukii-user-message-content") as HTMLElement,
    );
    expect(bubble).toHaveClass("cukii-user-bubble--collapsed");
    expect(bubble).not.toHaveClass("cukii-user-bubble--expanded");
    expect(canonicalCss()).toMatch(
      /\.cukii-user-content-shell\s*\{[^}]*cursor:\s*default/s,
    );

    const css = canonicalCss();
    expect(css).toMatch(
      /\.cukii-user-message-content\[data-cukii-scroll-folding="true"\]\s*\{[^}]*max-height:\s*var\(--cukii-sticky-visible-height\)/s,
    );
    expect(css).toMatch(
      /\.cukii-user-truncation-gradient\s*\{[^}]*height:\s*20px/s,
    );
    expect(css).not.toContain("transition: max-height");
    expect(css).not.toContain(".cukii-user-row-flow-spacer");
    expect(css).not.toMatch(
      /\.cukii-user-row--sticky\s*\{[^}]*min-height:\s*var\(--cukii-sticky-flow-height/s,
    );
    expect(css).toMatch(
      /\.cukii-user-fold-footer\s*\{[^}]*display:\s*flex;[^}]*line-height:\s*14px/s,
    );
    expect(css).toMatch(
      /\.cukii-user-fold-footer\s*\{[^}]*margin:\s*2px 0 -6px auto/s,
    );
    expect(css).toMatch(
      /\.cukii-user-message-bubble\[data-cukii-long-prompt="true"\][^}]*>\s*\.cukii-user-fold-footer\s*\{[^}]*position:\s*absolute;[^}]*right:\s*10px;[^}]*bottom:\s*4px;[^}]*margin:\s*0/s,
    );
    expect(css).toMatch(
      /\.cukii-user-message-content--collapsed\s+\.ProseMirror\s*\{[^}]*height:\s*20px;[^}]*white-space:\s*nowrap/s,
    );
    expect(css).toMatch(
      /\.cukii-user-message-content--collapsed br\s*\{[^}]*display:\s*none/s,
    );
    // Layout never keys off the collapse-progress attribute: the fold changes
    // the painted row and its inverse spacer by opposite amounts. The
    // attribute remains for debugging and tests only.
    expect(css).not.toMatch(
      /\.cukii-user-row--sticky\[data-cukii-collapse-progress/s,
    );
    expect(css).not.toMatch(
      /\.cukii-user-message-bubble\[data-cukii-long-prompt="true"\][^}]*>\s*\.cukii-user-fold-footer\s*\{[^}]*position:\s*static/s,
    );
    expect(css).toMatch(
      /\.cukii-user-fold-toggle\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;[^}]*padding:\s*0;[^}]*background:\s*transparent/s,
    );
    expect(css).not.toContain(".cukii-user-expand-button-container");
    expect(css).not.toContain(".cukii-user-collapse-button-container");
    expect(css).toMatch(
      /\.cukii-user-bubble--meta-inline\s*>\s*\.cukii-user-fold-footer\s*\{[^}]*position:\s*absolute/s,
    );
    expect(css).toMatch(
      /\.cukii-user-row--sticky[^}]*\.cukii-user-message-bubble[^}]*>\s*\.cukii-user-metadata\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*4px/s,
    );
    expect(css).toMatch(
      /\.cukii-user-row--sticky[^}]*\.cukii-user-content-shell[^}]*\.ProseMirror[^}]*p:last-child::after\s*\{[^}]*width:\s*calc\(var\(--cukii-meta-reserve\) \+ 4px\)/s,
    );
  } finally {
    globalThis.ResizeObserver = originalResizeObserver;
    if (scrollHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollHeight",
        scrollHeightDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    }
  }
});

test("marks an attachment capsule as foldable while preserving it in normal flow", async () => {
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => 140,
  });

  try {
    const { container } = render(
      <CukiiStickyUserMessage
        bubbleClassName="cukii-user-message-bubble"
        messageId="image-prompt"
        metadata={<span className="cukii-user-metadata">01:15</span>}
      >
        <img alt="Original attachment" src="data:image/png;base64,aW1hZ2U=" />
        <p>Text after the attachment</p>
      </CukiiStickyUserMessage>,
    );

    const bubble = container.querySelector(
      '[data-testid="cukii-user-bubble-image-prompt"]',
    );
    await waitFor(() =>
      expect(bubble).toHaveAttribute("data-cukii-long-prompt", "true"),
    );
    expect(bubble).not.toHaveAttribute("data-cukii-collapsible");
    expect(bubble?.querySelector("img")).not.toBeNull();
    expect(bubble?.querySelector(".cukii-user-metadata")?.textContent).toBe(
      "01:15",
    );
  } finally {
    if (scrollHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollHeight",
        scrollHeightDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    }
  }
});

test("does not classify a short text message as long because of its embedded reaction", async () => {
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this.classList?.contains("cukii-user-message-body")) return 20;
      if (this.classList?.contains("cukii-user-message-content")) return 64;
      return 0;
    },
  });

  try {
    const { container } = render(
      <CukiiStickyUserMessage
        bubbleClassName="cukii-user-message-bubble"
        messageId="short-reaction-prompt"
        reaction={
          <span className="cukii-message-reactions--embedded">reaction</span>
        }
      >
        Short text
      </CukiiStickyUserMessage>,
    );
    const bubble = container.querySelector(
      '[data-testid="cukii-user-bubble-short-reaction-prompt"]',
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );

    expect(bubble).not.toHaveAttribute("data-cukii-long-prompt");
    expect(
      bubble?.querySelector(".cukii-user-message-content"),
    ).toContainElement(
      bubble?.querySelector(".cukii-message-reactions--embedded") ?? null,
    );
  } finally {
    if (scrollHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollHeight",
        scrollHeightDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    }
  }
});

test("re-measures a long capsule after the first browser paint", async () => {
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  let contentReads = 0;
  let measuredHeight = 0;
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this.classList?.contains("cukii-user-message-content")) {
        contentReads += 1;
        measuredHeight = contentReads === 1 ? 0 : 140;
        return measuredHeight;
      }
      if (this.classList?.contains("cukii-user-message-body")) {
        return measuredHeight;
      }
      return 0;
    },
  });

  try {
    const { container } = render(
      <CukiiStickyUserMessage
        bubbleClassName="cukii-user-message-bubble"
        messageId="post-paint-prompt"
        metadata={<span className="cukii-user-metadata">01:16</span>}
      >
        <p>{"Long after layout ".repeat(12)}</p>
      </CukiiStickyUserMessage>,
    );
    const bubble = container.querySelector(
      '[data-testid="cukii-user-bubble-post-paint-prompt"]',
    );

    await waitFor(() =>
      expect(bubble).toHaveAttribute("data-cukii-long-prompt", "true"),
    );
    expect(contentReads).toBeGreaterThanOrEqual(2);
    expect(bubble?.querySelector(".cukii-user-fold-footer")).not.toBeNull();
  } finally {
    if (scrollHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollHeight",
        scrollHeightDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    }
  }
});

test("re-measures delayed Markdown content after its DOM mutation", async () => {
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  let markdownReady = false;
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (
        !this.classList?.contains("cukii-user-message-content") &&
        !this.classList?.contains("cukii-user-message-body")
      ) {
        return 0;
      }
      return markdownReady ? 140 : 0;
    },
  });

  try {
    const { container } = render(
      <CukiiStickyUserMessage
        bubbleClassName="cukii-user-message-bubble"
        messageId="delayed-markdown-prompt"
        metadata={<span className="cukii-user-metadata">01:17</span>}
      >
        <div />
      </CukiiStickyUserMessage>,
    );
    const bubble = container.querySelector(
      '[data-testid="cukii-user-bubble-delayed-markdown-prompt"]',
    );
    const content = bubble?.querySelector<HTMLElement>(
      ".cukii-user-message-content",
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    expect(bubble).not.toHaveAttribute("data-cukii-long-prompt");

    markdownReady = true;
    act(() => content?.appendChild(document.createTextNode("rendered")));
    await waitFor(() =>
      expect(bubble).toHaveAttribute("data-cukii-long-prompt", "true"),
    );
  } finally {
    if (scrollHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollHeight",
        scrollHeightDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    }
  }
});

test("keeps attachments in one horizontally scrolling micro-preview row", () => {
  const css = canonicalCss();
  expect(css).toMatch(
    /\.cukii-user-attachment-strip\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*gap:\s*4px;[^}]*overflow-x:\s*auto;[^}]*padding:\s*0 0 6px;[^}]*scrollbar-width:\s*thin/s,
  );
  expect(css).toMatch(
    /\.cukii-composer-attachment-strip\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*0;[^}]*width:\s*auto;[^}]*margin:\s*0;[^}]*padding:\s*6px 4px 4px 8px/s,
  );
  expect(css).toMatch(/\.cukii-input-footer\s*\{[^}]*z-index:\s*3/s);
  expect(css).toMatch(
    /\.cukii-user-attachment-card\s*\{[^}]*max-width:\s*180px;[^}]*height:\s*24px/s,
  );
  expect(css).toMatch(
    /\.cukii-user-attachment-card > img\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px/s,
  );
  expect(css).toMatch(
    /\.cukii-user-attachment-card--image\s*\{[^}]*--cukii-attachment-pill-background:\s*var\(\s*--vscode-input-background/s,
  );
  expect(css).toMatch(
    /\.cukii-user-bubble \.ProseMirror img,\s*\.cukii-user-bubble \.cukii-file-attachment-node-view\s*\{[^}]*display:\s*none !important/s,
  );
  expect(css).not.toContain(".cukii-code-block-node-view");
  expect(css).toContain(".cukii-image-lightbox");
  expect(css).toMatch(
    /\.cukii-user-message-content--collapsed\s+\.cukii-user-attachment-strip\s*\{[^}]*display:\s*none/s,
  );
});

test("does not render fold controls for a short prompt", async () => {
  const { store, container } = await renderWithProviders(<Chat />);
  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "short-sticky-prompt",
        title: "Short sticky prompt",
        history: [
          {
            message: { id: "short-user", role: "user", content: "Short" },
            contextItems: [],
          },
          {
            message: { id: "short-answer", role: "assistant", content: "OK" },
            contextItems: [],
          },
        ],
      },
    });
  });

  const bubble = container.querySelector(
    '[data-testid="cukii-user-bubble-short-user"]',
  );
  expect(bubble).not.toHaveAttribute("data-cukii-collapsible");
  expect(bubble?.querySelector('[aria-label="Show more"]')).toBeNull();
  expect(bubble?.querySelector('[aria-label="Show less"]')).toBeNull();
});

test("collapsed sticky wrapping is one nowrap line, not the expanded wrap (ID-249)", () => {
  const css = canonicalCss();
  const { container } = render(
    <div className="cukii-transcript">
      <div
        className="cukii-user-row cukii-user-row--sticky"
        data-cukii-collapse-progress="1.0000"
        data-testid="sticky-collapsed-row"
        style={
          {
            "--cukii-sticky-mask-height": "46px",
          } as CSSProperties
        }
      >
        <div className="cukii-user-message">
          <div className="cukii-user-message-bubble cukii-user-bubble--collapsed">
            <div className="cukii-user-content-shell">
              <div className="cukii-user-message-content cukii-user-message-content--collapsed">
                <div className="ProseMirror">
                  <p>https://getbb.app/</p>
                  <p>
                    посмотри, что это такое
                    <br />
                    extra wrap
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="cukii-assistant-row" data-testid="sticky-next-row">
        Next turn
      </div>
    </div>,
  );

  const collapsed = container.querySelector(
    ".cukii-user-message-content--collapsed",
  );
  expect(collapsed).not.toBeNull();
  expect(css).toMatch(
    /\.cukii-user-message-content--collapsed\s*\{[^}]*white-space:\s*nowrap/s,
  );
  expect(css).toMatch(
    /\.cukii-user-message-content--collapsed br\s*\{[^}]*display:\s*none/s,
  );
  // Layout no longer reads the collapse-progress attribute; the painted row
  // is the flow box, so no invisible sibling can leave a prompt-sized gap.
  // The attribute remains on the markup for debugging only.
  expect(css).not.toMatch(
    /\.cukii-user-row--sticky\[data-cukii-collapse-progress/s,
  );

  const artifactDir = process.env.CUKII_GUI_ARTIFACT_DIR;
  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "id249-270-275-sticky-collapse.html"),
      `<!doctype html><meta charset="utf-8"><title>ID-249/270/275 sticky collapse</title><style>${css}</style>${container.innerHTML}`,
      "utf8",
    );
  }
});

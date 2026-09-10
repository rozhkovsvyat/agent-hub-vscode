import { act, render, waitFor } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { renderWithProviders } from "../../../util/test/render";
import {
  CukiiStickyUserMessage,
  resolveStickyCollapseGeometry,
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
    /\.cukii-user-row--group-start,[^}]*--cukii-user-row-padding-bottom:\s*1px/s,
  );
  expect(css).toMatch(
    /\.cukii-user-row--group-middle,[^}]*\.cukii-user-row--group-end[^}]*--cukii-user-row-padding-top:\s*1px/s,
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

test("maps scroll distance to a reversible pixel-by-pixel sticky fold", () => {
  const fullHeight = 140;
  const forward = [100, 120, 140, 180, 220].map((scrollTop) =>
    resolveStickyCollapseGeometry({
      fullHeight,
      isAtStickyEdge: true,
      scrollTop,
      stickyStartScrollTop: 100,
    }),
  );

  expect(forward.map(({ visibleHeight }) => visibleHeight)).toEqual([
    140, 120, 100, 60, 20,
  ]);
  expect(forward.map(({ phase }) => phase)).toEqual([
    "folding",
    "folding",
    "folding",
    "folding",
    "collapsed",
  ]);

  const reverse = [220, 180, 140, 120, 100].map(
    (scrollTop) =>
      resolveStickyCollapseGeometry({
        fullHeight,
        isAtStickyEdge: true,
        scrollTop,
        stickyStartScrollTop: 100,
      }).visibleHeight,
  );
  expect(reverse).toEqual([20, 60, 100, 120, 140]);

  expect(
    resolveStickyCollapseGeometry({
      fullHeight,
      isAtStickyEdge: false,
      scrollTop: 220,
      stickyStartScrollTop: 100,
    }),
  ).toEqual({ phase: "flow", progress: 0, visibleHeight: 140 });
});

test("folds a long prompt only after it actually sticks to the transcript top", async () => {
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
    const content = bubble?.querySelector<HTMLElement>(
      ".cukii-user-message-content",
    )!;
    Object.defineProperty(transcript, "scrollTop", {
      configurable: true,
      value: 100,
      writable: true,
    });
    Object.defineProperty(row, "offsetTop", {
      configurable: true,
      // Blink reports a sticky row's painted offset after it pins. Recreating
      // the scroll effect on Show more/less must not adopt that moving value
      // as a new collapse origin.
      get: () => transcript.scrollTop,
    });
    Object.defineProperty(row, "offsetParent", {
      configurable: true,
      value: transcript,
    });
    transcript.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    let rowTop = 40;
    row.getBoundingClientRect = () => ({ top: rowTop }) as DOMRect;
    transcript.scrollTop = 60;
    act(() => transcript.dispatchEvent(new Event("scroll")));

    rowTop = 0;
    transcript.scrollTop = 100;
    act(() => transcript.dispatchEvent(new Event("scroll")));

    // Touching the sticky edge starts at the full height. Each subsequent
    // scroll pixel clips one content pixel while the row's flow height stays
    // fixed, so the transcript anchor cannot jump.
    await waitFor(() =>
      expect(content.dataset.cukiiScrollFolding).toBe("true"),
    );
    expect(
      content.style.getPropertyValue("--cukii-sticky-visible-height"),
    ).toBe("140px");
    expect(bubble).not.toHaveClass("cukii-user-bubble--collapsed");
    const stableFlowHeight = row.style.getPropertyValue(
      "--cukii-sticky-flow-height",
    );

    transcript.scrollTop = 140;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    await waitFor(() =>
      expect(
        content.style.getPropertyValue("--cukii-sticky-visible-height"),
      ).toBe("100px"),
    );
    expect(row.style.getPropertyValue("--cukii-sticky-flow-height")).toBe(
      stableFlowHeight,
    );

    transcript.scrollTop = 220;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    await waitFor(() =>
      expect(bubble).toHaveClass("cukii-user-bubble--collapsed"),
    );
    const clippedContent = bubble?.querySelector(
      ".cukii-user-message-content--collapsed",
    );
    const receipt = bubble?.querySelector(
      '[data-testid="cukii-message-receipt-long-user"]',
    );
    expect(clippedContent).not.toBeNull();
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
    expect(row.style.getPropertyValue("--cukii-sticky-flow-height")).toBe(
      stableFlowHeight,
    );
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

    // Reversing the wheel reveals the same pixels in reverse and still does
    // not alter the row's document-flow height.
    transcript.scrollTop = 180;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    await waitFor(() =>
      expect(
        content.style.getPropertyValue("--cukii-sticky-visible-height"),
      ).toBe("60px"),
    );
    expect(row.style.getPropertyValue("--cukii-sticky-flow-height")).toBe(
      stableFlowHeight,
    );

    // The end of a turn pushes its formerly sticky row above the viewport.
    // A one-sided `<=` check misclassified this negative top as still pinned.
    rowTop = -20;
    act(() => transcript.dispatchEvent(new Event("scroll")));
    await waitFor(() =>
      expect(bubble).not.toHaveClass("cukii-user-bubble--collapsed"),
    );
    expect(container.querySelector('[aria-label="Show more"]')).toBeNull();
    expect(container.querySelector('[aria-label="Show less"]')).toBeNull();

    // The prompt body is text, not a control. Once the row leaves the sticky
    // edge it stays fully expanded and clicking the ordinary chat message can
    // neither collapse it nor bring the chevron back.
    await user.click(
      bubble?.querySelector(".cukii-user-message-content") as HTMLElement,
    );
    expect(bubble).not.toHaveClass("cukii-user-bubble--collapsed");
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
    expect(css).toMatch(
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

test("keeps attachments in one horizontally scrolling micro-preview row", () => {
  const css = canonicalCss();
  expect(css).toMatch(
    /\.cukii-user-attachment-strip\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*gap:\s*4px;[^}]*overflow-x:\s*auto;[^}]*padding:\s*0 0 6px;[^}]*scrollbar-width:\s*thin/s,
  );
  expect(css).toMatch(
    /\.cukii-composer-attachment-strip\s*\{[^}]*width:\s*auto;[^}]*margin:\s*0;[^}]*padding:\s*6px 4px 4px 8px;[^}]*z-index:\s*1/s,
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

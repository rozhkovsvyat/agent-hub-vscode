import { act, render, waitFor } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { renderWithProviders } from "../../../util/test/render";
import {
  CukiiStickyUserMessage,
  resolveStickyFoldCap,
  resolveStickyTurnSlack,
  STICKY_BUBBLE_TERMINAL_HEIGHT_PX,
} from "../../../components/cukii/CukiiStickyUserMessage";
import { Chat } from "../Chat";

const canonicalCss = () =>
  readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

const ruleBody = (css: string, selector: RegExp): string | undefined =>
  css.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`, "s"))?.[1];

/**
 * Layout stubs for jsdom: the body reports the given natural prompt height
 * and the sticky row reports the given natural row height. Neither depends
 * on scroll position, which is the whole point of the CSS-driven fold.
 */
function stubStickyGeometry({
  bodyHeight,
  rowHeight,
  turnHeight = 0,
}: {
  bodyHeight: number;
  rowHeight: number;
  turnHeight?: number;
}) {
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  const rectDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "getBoundingClientRect",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      const element = this as HTMLElement;
      return element.classList?.contains("cukii-user-message-body")
        ? bodyHeight
        : 0;
    },
  });
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      const height = this.classList?.contains("cukii-user-row--sticky")
        ? rowHeight
        : this.classList?.contains("cukii-user-message-body")
          ? bodyHeight
          : this.classList?.contains("cukii-turn")
            ? turnHeight
            : 0;
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: height,
        width: 0,
        height,
        toJSON: () => ({}),
      } as DOMRect;
    },
  });
  return () => {
    if (scrollHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollHeight",
        scrollHeightDescriptor,
      );
    } else {
      delete (HTMLElement.prototype as any).scrollHeight;
    }
    if (rectDescriptor) {
      Object.defineProperty(
        Element.prototype,
        "getBoundingClientRect",
        rectDescriptor,
      );
    }
  };
}

function renderStickyTurn(
  props: Partial<Parameters<typeof CukiiStickyUserMessage>[0]> = {},
) {
  return render(
    <div className="cukii-transcript">
      <div className="cukii-turn" data-testid="turn">
        <div aria-hidden="true" className="cukii-turn-sentinel" />
        <div
          className="cukii-user-row cukii-user-row--sticky"
          data-testid="row"
        >
          <div className="cukii-user-message">
            <CukiiStickyUserMessage
              bubbleClassName="cukii-user-message-bubble"
              messageId="m1"
              metadata={<span className="cukii-user-metadata">12:00</span>}
              {...props}
            >
              <p>prompt</p>
            </CukiiStickyUserMessage>
          </div>
        </div>
        <div className="cukii-assistant-row">answer</div>
        <div aria-hidden="true" className="cukii-turn-slack" />
      </div>
    </div>,
  );
}

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
    // The 1px view-timeline subject opens the turn, the eviction slack
    // closes it; both are inert for assistive tech.
    expect(turn.firstElementChild).toHaveClass("cukii-turn-sentinel");
    expect(turn.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(turn.lastElementChild).toHaveClass("cukii-turn-slack");
    expect(turn.querySelector(".cukii-user-row-flow-spacer")).toBeNull();
  }
  // Every turn sits in the one clip box that keeps slack out of the scroll.
  expect(turns[0].parentElement).toHaveClass("cukii-turns");
  expect(turns[1].parentElement).toBe(turns[0].parentElement);

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
  expect(css).toMatch(
    /\.cukii-user-row--group-start,[^}]*--cukii-user-row-padding-bottom:\s*0px/s,
  );
  expect(css).toMatch(
    /\.cukii-user-row--group-middle,[^}]*\.cukii-user-row--group-end[^}]*--cukii-user-row-padding-top:\s*0px/s,
  );
  const stickyRowRule = ruleBody(css, /\.cukii-user-row--sticky/);
  expect(stickyRowRule).not.toContain("linear-gradient");
  const stickyMaskRule = ruleBody(css, /\.cukii-user-row--sticky::before/);
  expect(stickyMaskRule).toContain(
    "var(--cukii-canvas, var(--cukii-chat-background))",
  );
  expect(stickyMaskRule).toContain("mask-image");
  expect(stickyMaskRule).not.toContain("--vscode-sideBar-background");
});

test("the fold is a CSS scroll-driven animation, not JavaScript state (owner videos 29.09 / 01.10)", () => {
  const css = canonicalCss();
  // Registered length so the compositor can interpolate it and descendants
  // inherit the animated value.
  expect(css).toMatch(
    /@property --cukii-fold-px\s*\{[^}]*syntax:\s*"<length>"[^}]*inherits:\s*true[^}]*initial-value:\s*0px/s,
  );
  expect(css).toMatch(
    /@keyframes cukii-sticky-fold\s*\{\s*from\s*\{\s*--cukii-fold-px:\s*0px;?\s*\}\s*to\s*\{\s*--cukii-fold-px:\s*4000px;?\s*\}\s*\}/s,
  );
  // The turn hoists the sentinel's timeline and pulls the eviction slack
  // back out of the flow.
  const turnRule = ruleBody(css, /\.cukii-turn/);
  expect(turnRule).toContain("timeline-scope: --cukii-turn");
  expect(turnRule).toContain(
    "margin-bottom: calc(-1 * var(--cukii-turn-slack, 0px))",
  );
  const sentinelRule = ruleBody(css, /\.cukii-turn-sentinel/);
  expect(sentinelRule).toContain("height: 1px");
  expect(sentinelRule).toContain("margin-bottom: -1px");
  expect(sentinelRule).toContain("view-timeline: --cukii-turn block");
  expect(ruleBody(css, /\.cukii-turn-slack/)).toContain(
    "height: var(--cukii-turn-slack, 0px)",
  );
  // One scrolled pixel past the pin = one animated pixel: the range starts
  // at the row's own top edge (sentinel bottom minus its 1px) and spans
  // exactly 4000 scroll pixels for the 0→4000px keyframes.
  const stickyRowRule = ruleBody(css, /\.cukii-user-row--sticky/);
  expect(stickyRowRule).toContain("animation: cukii-sticky-fold linear both");
  expect(stickyRowRule).toContain("animation-timeline: --cukii-turn");
  expect(stickyRowRule).toContain(
    "animation-range: exit calc(100% - 1px) exit calc(100% + 3999px)",
  );
  // The painted fold is capped by the distance the row stays pinned, so a
  // row riding up with the end of its turn never opens a blank above the
  // content that follows (2.0.155 acceptance: long last prompt).
  expect(stickyRowRule).toContain(
    "--cukii-fold: min(var(--cukii-fold-px), var(--cukii-fold-cap, 100000px))",
  );
  // Short prompts never fold; the chevron's expanded state switches the
  // animation off instead of fighting it with JavaScript.
  expect(css).toMatch(
    /\.cukii-user-row--sticky:not\(:has\(\[data-cukii-long-prompt="true"\]\)\),\s*\.cukii-user-row--sticky\.cukii-user-row--expanded\s*\{\s*animation:\s*none;?\s*\}/s,
  );
  // Paint-only clip: layout never changes with the fold, so nothing below
  // the capsule can move because of it, and the clip stops at one text row
  // plus the bubble inset (38px).
  expect(css).toMatch(
    /\.cukii-user-row--sticky\s+\.cukii-user-message-bubble\[data-cukii-long-prompt="true"\]\s*\{[^}]*clip-path:\s*inset\(\s*0 0 min\(var\(--cukii-fold, 0px\), calc\(100% - 38px\)\) 0 round\s+var\(--cukii-bubble-radius\)\s*\)/s,
  );
  // No remnants of the scroll-tracking implementation may stay behind.
  expect(css).not.toContain("--cukii-sticky-visible-height");
  expect(css).not.toContain("--cukii-sticky-mask-height");
  expect(css).not.toContain("data-cukii-scroll-folding");
  expect(css).not.toContain("cukii-user-message-content--collapsed");
  expect(css).not.toContain("data-cukii-collapsible");
  expect(css).not.toContain("cukii-user-bubble--collapsed");
});

test("the canvas mask, receipt row and fade ride the clipped edge; the fade never eats the last line", () => {
  const css = canonicalCss();
  const maskRule = ruleBody(css, /\.cukii-user-row--sticky::before/)!;
  expect(maskRule.replace(/\s+/g, " ")).toContain(
    "height: calc( 100% - min( var(--cukii-fold, 0px), calc( 100% - var(--cukii-user-row-padding-top) - var(--cukii-user-row-padding-bottom) - 38px ) ) )",
  );
  expect(
    ruleBody(
      css,
      /\.cukii-user-message-bubble\[data-cukii-long-prompt="true"\]\s*>\s*\.cukii-user-fold-footer/,
    ),
  ).toContain(
    "bottom: calc(4px + min(var(--cukii-fold, 0px), calc(100% - 38px)))",
  );
  expect(
    ruleBody(
      css,
      /\.cukii-user-row--sticky\s+\.cukii-user-message-bubble\[data-cukii-long-prompt="true"\]\s*>\s*\.cukii-user-metadata/,
    ),
  ).toContain(
    "bottom: calc(4px + min(var(--cukii-fold, 0px), calc(100% - 38px)))",
  );
  const gradientRule = ruleBody(css, /\.cukii-user-truncation-gradient/)!;
  expect(gradientRule).toContain(
    "bottom: min(var(--cukii-fold, 0px), calc(100% - 20px))",
  );
  expect(gradientRule).toContain(
    "height: clamp(0px, calc(100% - 20px - var(--cukii-fold, 0px)), 20px)",
  );
  // Nothing folded yet → no fade, no chevron. Expanded → chevron stays.
  expect(css).toMatch(
    /@container style\(--cukii-fold-px: 0px\)\s*\{\s*\.cukii-user-truncation-gradient\s*\{\s*display:\s*none;?\s*\}\s*\.cukii-user-fold-toggle\s*\{\s*visibility:\s*hidden;?\s*\}\s*\}/s,
  );
  expect(css).toMatch(
    /\.cukii-user-bubble--expanded \.cukii-user-fold-toggle\s*\{\s*visibility:\s*visible/s,
  );
  // Attachments paint below the text inside a sticky capsule so the terminal
  // row is always the first text line; the receipt reserve keeps the text
  // out from under the footer at every fold position.
  expect(css).toMatch(
    /\.cukii-user-row--sticky\s+\.cukii-user-message-bubble\[data-cukii-long-prompt="true"\]\s+\.cukii-user-attachment-strip\s*\{\s*order:\s*2/s,
  );
  // Only the first visual line (the terminal row) reserves the receipt
  // width. Padding the whole editor narrowed every line: in a 207px panel the
  // text column was 32px and a 41-line prompt grew to 11 193px.
  expect(css).toMatch(
    /\.cukii-user-row--sticky\s+\.cukii-user-message-bubble\[data-cukii-long-prompt="true"\]\s+\.ProseMirror\s*>\s*:first-child::before\s*\{[^}]*float:\s*right;[^}]*width:\s*calc\(var\(--cukii-meta-reserve, 31px\) \+ 20px\);[^}]*height:\s*1lh/s,
  );
  expect(css).not.toMatch(
    /\.cukii-user-message-bubble\[data-cukii-long-prompt="true"\]\s+\.ProseMirror\s*\{[^}]*padding-right/s,
  );
});

test("the last turn reserves no eviction slack, so the transcript never scrolls into a blank", () => {
  const css = canonicalCss();
  expect(css).toMatch(
    /\.cukii-turn:not\(:has\(~ \.cukii-turn\)\)\s*\{\s*margin-bottom:\s*0;?\s*\}/s,
  );
  expect(css).toMatch(
    /\.cukii-turn:not\(:has\(~ \.cukii-turn\)\)\s*>\s*\.cukii-turn-slack\s*\{\s*display:\s*none;?\s*\}/s,
  );
});

test("turns live in a clip box so eviction slack is never scrollable", () => {
  // Long prompt, short answer, short last follow-up: the long turn's slack
  // reached past the transcript's real end and the reader could scroll into
  // a 1442px blank (headless red control, 2.0.155). `clip` is not a scroll
  // container, so sticky pinning and the view timeline are unaffected.
  const turnsRule = ruleBody(canonicalCss(), /\.cukii-turns/)!;
  expect(turnsRule).toContain("overflow-y: clip");
  expect(turnsRule).toContain("overflow-x: visible");
  expect(turnsRule).not.toMatch(/overflow(-y)?:\s*(hidden|auto|scroll)/);
});

test("resolveStickyFoldCap is the part of the turn below the row", () => {
  expect(resolveStickyFoldCap({ turnHeight: 500, rowHeight: 192 })).toBe(308);
  expect(resolveStickyFoldCap({ turnHeight: 100, rowHeight: 192 })).toBe(0);
});

test("the pinned row carries its fold cap: the distance it stays pinned", async () => {
  const restore = stubStickyGeometry({
    bodyHeight: 140,
    rowHeight: 192,
    turnHeight: 232,
  });
  try {
    const { getByTestId } = renderStickyTurn();
    await waitFor(() =>
      expect(
        getByTestId("row").style.getPropertyValue("--cukii-fold-cap"),
      ).toBe("40px"),
    );
  } finally {
    restore();
  }
});

test("resolveStickyTurnSlack reserves exactly the hidden part of a long row", () => {
  // 14 + 12 row padding around a 332px bubble: the next turn may push the
  // row out only once the one-line row (38px + paddings) is all that shows.
  expect(
    resolveStickyTurnSlack({
      rowHeight: 358,
      rowPaddingTop: 14,
      rowPaddingBottom: 12,
      longPrompt: true,
      expanded: false,
    }),
  ).toBe(358 - 14 - 12 - STICKY_BUBBLE_TERMINAL_HEIGHT_PX);
  expect(
    resolveStickyTurnSlack({
      rowHeight: 358,
      rowPaddingTop: 14,
      rowPaddingBottom: 12,
      longPrompt: true,
      expanded: true,
    }),
  ).toBe(0);
  expect(
    resolveStickyTurnSlack({
      rowHeight: 53.5,
      rowPaddingTop: 14,
      rowPaddingBottom: 12,
      longPrompt: false,
      expanded: false,
    }),
  ).toBe(0);
  // A one-line row is never negative slack.
  expect(
    resolveStickyTurnSlack({
      rowHeight: 60,
      rowPaddingTop: 14,
      rowPaddingBottom: 12,
      longPrompt: true,
      expanded: false,
    }),
  ).toBe(0);
});

test("a long prompt is marked foldable and reserves eviction slack on its turn", async () => {
  const restore = stubStickyGeometry({ bodyHeight: 140, rowHeight: 192 });
  try {
    const { container, getByTestId } = renderStickyTurn();
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="cukii-user-bubble-m1"]'),
      ).toHaveAttribute("data-cukii-long-prompt", "true"),
    );
    // 192 - 14/12 paddings are 0 in jsdom (no computed padding) → 192 - 38.
    await waitFor(() =>
      expect(
        getByTestId("turn").style.getPropertyValue("--cukii-turn-slack"),
      ).toBe(`${192 - STICKY_BUBBLE_TERMINAL_HEIGHT_PX}px`),
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      ".cukii-user-fold-toggle",
    )!;
    expect(toggle).toHaveAttribute("aria-label", "Show more");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.disabled).toBe(false);
    expect(
      container.querySelector(".cukii-user-truncation-gradient"),
    ).not.toBeNull();
    // The receipt sits inside the fold footer so it rides the clipped edge.
    expect(
      container.querySelector(".cukii-user-fold-footer .cukii-user-metadata"),
    ).not.toBeNull();
  } finally {
    restore();
  }
});

test("the chevron owns the expanded state: it switches the row animation off and releases the slack", async () => {
  const restore = stubStickyGeometry({ bodyHeight: 140, rowHeight: 192 });
  try {
    const { container, getByTestId } = renderStickyTurn();
    await waitFor(() =>
      expect(
        getByTestId("turn").style.getPropertyValue("--cukii-turn-slack"),
      ).not.toBe(""),
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      ".cukii-user-fold-toggle",
    )!;
    await act(async () => {
      toggle.click();
    });
    const bubble = container.querySelector(
      '[data-testid="cukii-user-bubble-m1"]',
    )!;
    expect(bubble).toHaveClass("cukii-user-bubble--expanded");
    expect(getByTestId("row")).toHaveClass("cukii-user-row--expanded");
    expect(
      getByTestId("turn").style.getPropertyValue("--cukii-turn-slack"),
    ).toBe("");
    expect(toggle).toHaveAttribute("aria-label", "Show less");
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await act(async () => {
      toggle.click();
    });
    expect(bubble).not.toHaveClass("cukii-user-bubble--expanded");
    expect(getByTestId("row")).not.toHaveClass("cukii-user-row--expanded");
    await waitFor(() =>
      expect(
        getByTestId("turn").style.getPropertyValue("--cukii-turn-slack"),
      ).toBe(`${192 - STICKY_BUBBLE_TERMINAL_HEIGHT_PX}px`),
    );
  } finally {
    restore();
  }
});

test("a short prompt exposes no fold controls and reserves no slack", async () => {
  const restore = stubStickyGeometry({ bodyHeight: 20, rowHeight: 64 });
  try {
    const { container, getByTestId } = renderStickyTurn();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const bubble = container.querySelector(
      '[data-testid="cukii-user-bubble-m1"]',
    )!;
    expect(bubble).not.toHaveAttribute("data-cukii-long-prompt");
    expect(container.querySelector(".cukii-user-fold-toggle")).toBeNull();
    expect(
      container.querySelector(".cukii-user-truncation-gradient"),
    ).toBeNull();
    expect(
      getByTestId("turn").style.getPropertyValue("--cukii-turn-slack"),
    ).toBe("");
    // Metadata is rendered directly when there is no fold footer.
    expect(container.querySelector(".cukii-user-metadata")).not.toBeNull();
  } finally {
    restore();
  }
});

test("keeps a media-only capsule intact instead of folding it to an empty row", async () => {
  const restore = stubStickyGeometry({ bodyHeight: 80, rowHeight: 120 });
  try {
    const { container, getByTestId } = renderStickyTurn({
      foldableText: false,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      container.querySelector('[data-testid="cukii-user-bubble-m1"]'),
    ).not.toHaveAttribute("data-cukii-long-prompt");
    expect(container.querySelector(".cukii-user-fold-toggle")).toBeNull();
    expect(
      getByTestId("turn").style.getPropertyValue("--cukii-turn-slack"),
    ).toBe("");
  } finally {
    restore();
  }
});

test("does not classify a short text message as long because of its embedded reaction", async () => {
  // The body (text) is one line; the reaction row lives outside the body.
  const restore = stubStickyGeometry({ bodyHeight: 20, rowHeight: 108 });
  try {
    const { container } = renderStickyTurn({
      reaction: (
        <div className="cukii-message-reactions" style={{ height: 44 }}>
          ❤️
        </div>
      ),
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      container.querySelector('[data-testid="cukii-user-bubble-m1"]'),
    ).not.toHaveAttribute("data-cukii-long-prompt");
    expect(container.querySelector(".cukii-message-reactions")).not.toBeNull();
  } finally {
    restore();
  }
});

test("re-measures a capsule whose Markdown finishes layout after mount", async () => {
  let bodyHeight = 0;
  const restoreScroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList?.contains(
        "cukii-user-message-body",
      )
        ? bodyHeight
        : 0;
    },
  });
  try {
    const { container } = renderStickyTurn();
    const bubble = container.querySelector(
      '[data-testid="cukii-user-bubble-m1"]',
    )!;
    expect(bubble).not.toHaveAttribute("data-cukii-long-prompt");
    bodyHeight = 140;
    // Delayed content arrives as a DOM mutation inside the content frame.
    await act(async () => {
      container
        .querySelector(".cukii-user-message-body p")!
        .append(document.createTextNode(" more"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() =>
      expect(bubble).toHaveAttribute("data-cukii-long-prompt", "true"),
    );
  } finally {
    if (restoreScroll) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollHeight",
        restoreScroll,
      );
    }
  }
});

test("keeps attachments in one horizontally scrolling micro-preview row", () => {
  const css = canonicalCss();
  // The base rule, not the sticky `order` override declared earlier.
  const stripRule = css.match(
    /\n\.cukii-user-attachment-strip\s*\{([^}]*)\}/s,
  )?.[1];
  expect(stripRule).toBeDefined();
  expect(stripRule).toMatch(/overflow-x:\s*auto/);
  expect(stripRule).toMatch(/flex-wrap:\s*nowrap/);
});

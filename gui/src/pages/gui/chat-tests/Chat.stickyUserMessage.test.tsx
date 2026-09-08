import { act, render, waitFor } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { renderWithProviders } from "../../../util/test/render";
import { CukiiStickyUserMessage } from "../../../components/cukii/CukiiStickyUserMessage";
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

test("folds a long sticky prompt like Claude while keeping time and ticks in the footer", async () => {
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList?.contains(
        "cukii-user-message-content",
      )
        ? 140
        : 0;
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
    expect(receipt?.textContent).toBe("01:13");
    expect(clippedContent?.contains(receipt ?? null)).toBe(false);
    expect(
      receipt?.querySelector(
        '[data-testid="cukii-message-receipt-status-read"]',
      ),
    ).not.toBeNull();

    const collapsedToggle = container.querySelector('[aria-label="Show more"]');
    const footer = bubble?.querySelector(".cukii-user-fold-footer");
    expect(footer).not.toBeNull();
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

    // The prompt body is text, not a control: only the chevron folds it. A
    // click here used to expand the bubble, which is why the body advertised a
    // pointer cursor it had no business showing.
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
      /\.cukii-user-message-content--collapsed\s*\{[^}]*max-height:\s*60px/s,
    );
    expect(css).toMatch(
      /\.cukii-user-truncation-gradient\s*\{[^}]*height:\s*50px/s,
    );
    expect(css).toContain("transition: max-height 300ms ease-in-out");
    expect(css).toMatch(
      /\.cukii-user-fold-footer\s*\{[^}]*display:\s*flex;[^}]*line-height:\s*14px/s,
    );
    expect(css).toMatch(
      /\.cukii-user-fold-footer\s*\{[^}]*margin:\s*2px 0 -6px auto/s,
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

test("never clips a visual attachment inside the text fold", () => {
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
    /\.cukii-user-attachment-strip\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*none/s,
  );
  expect(css).toMatch(
    /\.cukii-user-attachment-strip::\-webkit-scrollbar\s*\{[^}]*display:\s*none/s,
  );
  expect(css).toMatch(
    /\.cukii-user-attachment-card\s*\{[^}]*max-width:\s*180px;[^}]*height:\s*24px/s,
  );
  expect(css).toMatch(
    /\.cukii-user-attachment-card > img\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px/s,
  );
  expect(css).toMatch(
    /\.cukii-user-bubble \.ProseMirror img,\s*\.cukii-user-bubble \.cukii-file-attachment-node-view\s*\{[^}]*display:\s*none !important/s,
  );
  expect(css).not.toContain(".cukii-code-block-node-view");
  expect(css).toContain(".cukii-image-lightbox");
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

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
  expect(css).not.toMatch(
    /\.cukii-user-row--sticky \.cukii-user-message[^}]*max-width:\s*none/s,
  );
  const stickyRowRule = css.match(
    /\.cukii-user-row--sticky\s*\{([^}]*)\}/s,
  )?.[1];
  expect(stickyRowRule).toContain("var(--cukii-chat-background)");
  expect(stickyRowRule).not.toContain("--vscode-sideBar-background");
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
    expect(receipt?.parentElement).toBe(bubble);
    expect(
      receipt?.querySelector(
        '[data-testid="cukii-message-receipt-status-read"]',
      ),
    ).not.toBeNull();

    await user.click(container.querySelector('[aria-label="Show more"]')!);
    expect(bubble).toHaveClass("cukii-user-bubble--expanded");
    expect(
      bubble?.querySelector(".cukii-user-message-content--collapsed"),
    ).toBeNull();
    expect(receipt?.parentElement).toBe(bubble);
    expect(container.querySelector('[aria-label="Show less"]')).not.toBeNull();

    await user.click(container.querySelector('[aria-label="Show less"]')!);
    expect(bubble).toHaveClass("cukii-user-bubble--collapsed");

    await user.click(
      bubble?.querySelector(".cukii-user-message-content") as HTMLElement,
    );
    expect(bubble).toHaveClass("cukii-user-bubble--expanded");

    const css = canonicalCss();
    expect(css).toMatch(
      /\.cukii-user-message-content--collapsed\s*\{[^}]*max-height:\s*60px/s,
    );
    expect(css).toMatch(
      /\.cukii-user-truncation-gradient\s*\{[^}]*height:\s*50px/s,
    );
    expect(css).toContain("transition: max-height 300ms ease-in-out");
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

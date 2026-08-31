import { act } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { vi } from "vitest";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import {
  getElementByTestId,
  getElementByText,
  sendInputWithMockedResponse,
} from "../../../util/test/utils";
import { Chat } from "../Chat";
import {
  acceptToolCall,
  setMode,
  setBridgeWait,
  setIsInEdit,
  setToolCallCalling,
  switchBrokerModel,
} from "../../../redux/slices/sessionSlice";
import { setCodeToEdit } from "../../../redux/slices/editState";

const canonicalCss = () =>
  readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

test("should render input box", async () => {
  await renderWithProviders(<Chat />);
  await getElementByTestId("continue-input-box-main-editor-input");
});

test("shows the Cukii broker entry instead of the retired mode cycler", async () => {
  await renderWithProviders(<Chat />);
  await getElementByTestId("broker-menu-button");
  expect(
    document.querySelector('[data-testid="mode-select-button"]'),
  ).toBeNull();
});

test("should send a message and receive a response", async () => {
  const { ideMessenger, store } = await renderWithProviders(<Chat />);

  // First add and select the mock LLM
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
    store.dispatch(setMode("chat"));
  });

  const CONTENT = "Expected response";
  const INPUT = "User input";

  await sendInputWithMockedResponse(ideMessenger, INPUT, [
    { role: "assistant", content: CONTENT },
  ]);

  await getElementByText(CONTENT);
});

test("Escape cancels a streaming response", async () => {
  const { store } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({ type: "session/setActive" });
  });
  expect(store.getState().session.isStreaming).toBe(true);

  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });

  expect(store.getState().session.isStreaming).toBe(false);
});

test("Escape uses the real cancel lifecycle once and renders Interrupted", async () => {
  const { store, container } = await renderWithProviders(<Chat />);
  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "escape-interrupt",
        title: "Escape interrupt",
        history: [
          {
            message: { id: "user", role: "user", content: "run" },
            contextItems: [],
          },
          {
            message: { id: "assistant", role: "assistant", content: "Running" },
            contextItems: [],
          },
        ],
      },
    });
    store.dispatch({ type: "session/setActive" });
  });
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        repeat: true,
        bubbles: true,
      }),
    );
  });
  expect(store.getState().session.isStreaming).toBe(false);
  expect(await getElementByTestId("turn-interrupted")).toBeTruthy();
  expect(
    container.querySelector('[data-testid="cukii-spinner-row"]'),
  ).toBeNull();
});

test("Escape is inert while idle and yields to an open menu", async () => {
  const { store } = await renderWithProviders(<Chat />);
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(store.getState().session.isStreaming).toBe(false);

  await act(async () => {
    store.dispatch({ type: "session/setActive" });
  });
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  document.body.append(menu);
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(store.getState().session.isStreaming).toBe(true);
  menu.remove();
});

test("Ctrl+Backspace does not cancel a streaming response", async () => {
  const { store } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({ type: "session/setActive" });
  });
  expect(store.getState().session.isStreaming).toBe(true);

  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        ctrlKey: true,
        bubbles: true,
      }),
    );
  });

  expect(store.getState().session.isStreaming).toBe(true);
});

test("streaming toolbar has no Ctrl+Backspace stop hint", async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({ type: "session/setActive" });
  });

  const toolbar = container.querySelector(
    '[data-testid="cukii-streaming-toolbar"]',
  );
  expect(toolbar).not.toBeNull();
  expect(toolbar?.textContent ?? "").not.toMatch(/Backspace/i);
  expect(toolbar?.textContent ?? "").not.toMatch(/to stop/i);
});

test("streaming loader lives in the transcript, not on the composer", async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({ type: "session/setActive" });
  });

  const toolbar = container.querySelector(
    '[data-testid="cukii-streaming-toolbar"]',
  );
  const transcript = container.querySelector(".cukii-transcript");
  const composer = container.querySelector(".cukii-main-input-shell");

  expect(toolbar).not.toBeNull();
  expect(transcript).not.toBeNull();
  expect(transcript?.contains(toolbar)).toBe(true);
  expect(composer?.contains(toolbar)).toBe(false);
  expect(
    container.querySelector("[data-testid='cukii-spinner-row']"),
  ).not.toBeNull();
});

test("user bubbles are not timeline items", async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "timeline-user-row",
        title: "Timeline user row",
        history: [
          {
            message: { id: "user-1", role: "user", content: "Hello from user" },
            contextItems: [],
          },
          {
            message: {
              id: "assistant-1",
              role: "assistant",
              content: "Hello from assistant",
            },
            contextItems: [],
          },
        ],
      },
    });
  });

  const userBox = container.querySelector(
    '[data-testid="continue-input-box-user-1"]',
  );
  expect(userBox).not.toBeNull();
  expect(userBox?.className).toMatch(/cukii-user-bubble/);
  expect(userBox?.closest(".cukii-user-row")).not.toBeNull();
  expect(userBox?.closest(".cukii-timeline-item")).toBeNull();
  expect(userBox?.closest(".cukii-timeline-checkpoint")).toBeNull();
});

test("a queued follow-up immediately renders one sent check inside its bubble", async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "message-receipt",
        title: "Message receipt",
        history: [
          {
            message: { id: "follow-up", role: "user", content: "Short text" },
            contextItems: [],
            isSteer: true,
            steerStatus: "queued",
            steerSentAt: 1_700_000_000_000,
          },
        ],
      },
    });
  });

  const receipt = container.querySelector(
    '[data-testid="cukii-message-receipt-follow-up"]',
  );
  expect(receipt?.textContent).toMatch(/^01:13$/);
  expect(
    receipt?.querySelector('[data-testid="cukii-message-receipt-status-sent"]'),
  ).not.toBeNull();
  expect(container.textContent).not.toContain("Delivered");
  const bubble = receipt?.closest(".cukii-user-message-bubble");
  expect(bubble).not.toBeNull();
  expect(bubble?.querySelector(".cukii-user-bubble")).not.toBeNull();
  expect(receipt?.parentElement).toHaveClass("cukii-user-message-bubble");
});

test("read follow-up uses the compact overlapping double-check SVG", async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "read-message-receipt",
        title: "Read message receipt",
        history: [
          {
            message: { id: "read-follow-up", role: "user", content: "Seen" },
            contextItems: [],
            isSteer: true,
            steerStatus: "read",
            steerSentAt: 1_700_000_000_000,
          },
        ],
      },
    });
  });

  const receipt = container.querySelector(
    '[data-testid="cukii-message-receipt-read-follow-up"]',
  );
  const readStatus = receipt?.querySelector(
    '[data-testid="cukii-message-receipt-status-read"]',
  );
  expect(receipt).toHaveAttribute(
    "aria-label",
    expect.stringContaining("read"),
  );
  expect(readStatus?.querySelectorAll("path")).toHaveLength(2);
  expect(receipt?.textContent).toBe("01:13");
  expect(readStatus).toHaveAttribute("width", "16");
  expect(readStatus).toHaveAttribute("height", "10");
});

test("short, multiline and image user turns stay in the right bubble lane while agent rows stay left", async () => {
  const { store, container } = await renderWithProviders(<Chat />);
  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "responsive-user-bubbles",
        title: "Responsive user bubbles",
        history: [
          {
            message: { id: "short", role: "user", content: "Hi" },
            contextItems: [],
            isSteer: true,
            steerSentAt: 1_700_000_000_000,
            steerStatus: "delivered",
          },
          {
            message: {
              id: "multiline",
              role: "user",
              content:
                "First line\nSecond line with a-very-long-token-that-wraps",
            },
            contextItems: [],
            isSteer: true,
            steerSentAt: 1_700_000_000_000,
            steerStatus: "read",
          },
          {
            message: {
              id: "image",
              role: "user",
              content: [
                { type: "text", text: "Image" },
                {
                  type: "imageUrl",
                  imageUrl: { url: "data:image/png;base64,aW1hZ2U=" },
                },
              ],
            },
            contextItems: [],
            isSteer: true,
            steerSentAt: 1_700_000_000_000,
            steerStatus: "delivered",
          },
          {
            message: { id: "agent", role: "assistant", content: "Answer" },
            contextItems: [],
          },
        ],
      },
    });
  });

  const userRows = container.querySelectorAll(".cukii-user-row");
  expect(userRows).toHaveLength(3);
  for (const row of userRows) {
    expect(row.querySelector(".cukii-user-message-bubble")).not.toBeNull();
  }
  expect(
    container.querySelector('[data-testid="cukii-message-receipt-short"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[data-testid="cukii-message-receipt-multiline"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[data-testid="cukii-message-receipt-image"]'),
  ).not.toBeNull();
  expect(container.querySelector('[data-testid="saved-row-3"]')).toBeNull();
  expect(container.textContent).toContain("Answer");
});

test("deferred image follow-up visibly reports that it will run next turn", async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "deferred-image-receipt",
        title: "Deferred image receipt",
        history: [
          {
            message: {
              id: "image-follow-up",
              role: "user",
              content: [
                { type: "text", text: "Inspect this" },
                {
                  type: "imageUrl",
                  imageUrl: { url: "data:image/png;base64,aW1hZ2U=" },
                },
              ],
            },
            contextItems: [],
            isSteer: true,
            steerStatus: "deferred",
            steerSentAt: 1_700_000_000_000,
          },
        ],
      },
    });
  });

  const receipt = container.querySelector(
    '[data-testid="cukii-message-receipt-image-follow-up"]',
  );
  expect(
    receipt?.querySelector('[data-testid="cukii-message-receipt-status-sent"]'),
  ).not.toBeNull();
  expect(receipt).toHaveAttribute(
    "aria-label",
    expect.stringContaining("queued for the next turn"),
  );
});

test("assistant text and tool calls render as sibling timeline items", async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "timeline-tool-rows",
        title: "Timeline tool rows",
        history: [
          {
            message: { id: "user-1", role: "user", content: "Search the repo" },
            contextItems: [],
          },
          {
            message: {
              id: "assistant-1",
              role: "assistant",
              content: "Sure, let me search.",
            },
            contextItems: [],
            toolCallStates: [
              {
                toolCallId: "tool-1",
                toolCall: {
                  id: "tool-1",
                  type: "function",
                  function: { name: "grep", arguments: '{"pattern":"foo"}' },
                },
                status: "done",
                parsedArgs: { pattern: "foo" },
              },
            ],
          },
        ],
      },
    });
  });

  const timelineItems = container.querySelectorAll(".cukii-timeline-item");
  expect(timelineItems).toHaveLength(2);

  const assistantTextItem = container.querySelector(
    ".cukii-timeline-item.cukii-timeline-event",
  );
  const toolItem = container.querySelector(
    ".cukii-timeline-item.cukii-timeline-checkpoint",
  );

  expect(assistantTextItem).not.toBeNull();
  expect(toolItem).not.toBeNull();
  expect(assistantTextItem?.contains(toolItem ?? null)).toBe(false);
  expect(toolItem?.contains(assistantTextItem ?? null)).toBe(false);
});

test("renders a persisted Claude-style model switch boundary before the next turn", async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch(
      switchBrokerModel({
        model: "codex-5-6-terra",
        displayName: "GPT-5.6 Terra",
      }),
    );
    store.dispatch({
      type: "session/submitEditorAndInitAtIndex",
      payload: { index: 1, editorState: { type: "doc" } },
    });
  });

  const boundary = container.querySelector(
    '[data-testid="cukii-model-switch"]',
  );
  expect(boundary?.textContent).toContain("Switched to GPT-5.6 Terra");
  expect(boundary?.querySelectorAll(".cukii-model-switch-wave")).toHaveLength(
    2,
  );
  expect(boundary?.nextElementSibling).toHaveClass("cukii-user-row");
  expect(boundary?.closest(".cukii-timeline-item")).toBeNull();

  const css = canonicalCss();
  expect(css).toContain("gap: 10px");
  expect(css).toContain("padding: 8px 0");
  expect(css).toContain("width='14' height='7'");
  expect(css).toContain("@media screen and (max-width: 330px)");
});

test("streaming toolbar follows the current transcript", async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "loader-placement",
        title: "Loader placement",
        history: [
          {
            message: { id: "previous-user", role: "user", content: "Earlier" },
            contextItems: [],
          },
          {
            message: {
              id: "previous-answer",
              role: "assistant",
              content: "Earlier answer",
            },
            contextItems: [],
          },
          {
            message: {
              id: "current-user",
              role: "user",
              content: "Current request",
            },
            contextItems: [],
          },
          {
            message: {
              id: "current-answer",
              role: "assistant",
              content: "Current transcript",
            },
            contextItems: [],
          },
        ],
      },
    });
    store.dispatch({ type: "session/setActive" });
  });

  const toolbar = container.querySelector(
    '[data-testid="cukii-streaming-toolbar"]',
  );
  const currentTranscript = await getElementByText("Current transcript");

  expect(toolbar).not.toBeNull();
  expect(toolbar?.compareDocumentPosition(currentTranscript) ?? 0).toBe(
    Node.DOCUMENT_POSITION_PRECEDING,
  );
});

test("thinking label sits above the streaming loader", async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "thinking-above-loader",
        title: "Thinking above loader",
        history: [
          {
            message: {
              id: "current-user",
              role: "user",
              content: "Current request",
            },
            contextItems: [],
          },
          {
            message: {
              id: "current-thinking",
              role: "thinking",
              content: "Reasoning in progress",
            },
            contextItems: [],
          },
        ],
      },
    });
    store.dispatch({ type: "session/setActive" });
  });

  const thinking = await getElementByTestId("thinking-block-peek");
  const toolbar = container.querySelector(
    '[data-testid="cukii-streaming-toolbar"]',
  );

  expect(thinking.textContent).toMatch(/Thinking/);
  expect(thinking.querySelector(".cukii-thinking-glyph")).toBeNull();
  expect(toolbar).not.toBeNull();
  expect(toolbar?.compareDocumentPosition(thinking) ?? 0).toBe(
    Node.DOCUMENT_POSITION_PRECEDING,
  );
});

test("shell tool calls render compact IN/OUT command cards without legacy terminals", async () => {
  const { store, container } = await renderWithProviders(<Chat />);

  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "terminal-cards",
        title: "Terminal cards",
        history: [
          {
            message: { id: "user-1", role: "user", content: "run checks" },
            contextItems: [],
          },
          {
            message: {
              id: "assistant-1",
              role: "assistant",
              content: "Running the checks now.",
            },
            contextItems: [],
            toolCallStates: [1, 2, 3].map((n) => ({
              toolCallId: `term-${n}`,
              toolCall: {
                id: `term-${n}`,
                type: "function",
                function: {
                  name: "run_terminal_command",
                  arguments: `{"command":"echo ${n}"}`,
                },
              },
              status: "done",
              parsedArgs: { command: `echo ${n}` },
              output: [
                {
                  name: "Tool output",
                  description: "stdout",
                  content: `ok ${n}`,
                  hidden: false,
                },
              ],
            })),
          },
        ],
      },
    });
  });

  expect(
    container.querySelectorAll('[data-testid="terminal-container"]'),
  ).toHaveLength(0);
  expect(
    container.querySelectorAll('[data-testid="cukii-command-card"]'),
  ).toHaveLength(3);

  const timelineItems = container.querySelectorAll(".cukii-timeline-item");
  expect(timelineItems.length).toBeGreaterThanOrEqual(4);
  timelineItems.forEach((item) => {
    expect(item.querySelector(".cukii-timeline-item")).toBeNull();
  });
});

test("tool start/start/complete race keeps the stream loader active while a tool is active", async () => {
  const { store, container } = await renderWithProviders(<Chat />);
  const tools = ["first", "second"].map((id) => ({
    toolCallId: id,
    toolCall: {
      id,
      type: "function" as const,
      function: { name: "run_terminal_command", arguments: "{}" },
    },
    status: "generated" as const,
    parsedArgs: { command: `echo ${id}` },
  }));
  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "tool-race",
        title: "Tool race",
        history: [
          {
            message: { id: "assistant", role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: tools,
          },
        ],
      },
    });
    store.dispatch({ type: "session/setActive" });
    store.dispatch(setToolCallCalling({ toolCallId: "first" }));
    store.dispatch(setToolCallCalling({ toolCallId: "second" }));
  });
  expect(container.querySelectorAll('[data-cukii-active="true"]')).toHaveLength(
    2,
  );
  expect(
    container.querySelector(".cukii-timeline-current")?.textContent,
  ).toContain("Shell");
  expect(
    container.querySelector('[data-testid="cukii-spinner-row"] .cukii-crumbs'),
  ).toHaveClass("cukii-crumbs-active");

  await act(async () => {
    store.dispatch(acceptToolCall({ toolCallId: "second" }));
    store.dispatch(acceptToolCall({ toolCallId: "first" }));
  });
  const active = container.querySelectorAll('[data-cukii-active="true"]');
  expect(active).toHaveLength(1);
  expect(active[0]).toHaveAttribute("data-testid", "cukii-spinner-row");
  const spinner = container.querySelector('[data-testid="cukii-spinner-row"]');
  const cards = container.querySelectorAll(
    '[data-testid="cukii-command-card"]',
  );
  expect(spinner?.compareDocumentPosition(cards[cards.length - 1]) ?? 0).toBe(
    Node.DOCUMENT_POSITION_PRECEDING,
  );
});

test("loader renders and cycles for an active tool, but yields to bridge wait and edit mode", async () => {
  vi.useFakeTimers();
  const { store, container } = await renderWithProviders(<Chat />);
  await act(async () => {
    store.dispatch({ type: "session/setActive" });
    store.dispatch(
      setToolCallCalling({
        toolCallId: "streaming-tool",
      }),
    );
  });
  const toolbar = container.querySelector(
    '[data-testid="cukii-streaming-toolbar"]',
  );
  expect(toolbar).not.toBeNull();
  expect(toolbar?.querySelector(".cukii-crumbs")).toHaveClass(
    "cukii-crumbs-active",
  );
  await act(async () => {
    vi.advanceTimersByTime(4_000);
  });
  expect(toolbar?.textContent).toContain("Combulating..");
  const css = canonicalCss();
  expect(css).toMatch(
    /\.cukii-crumbs-active circle\s*\{[^}]*animation:\s*cukiiCrumbVertex\s+1\.26s[^}]*infinite/s,
  );
  expect(css).not.toMatch(
    /\.cukii-crumbs-active circle\s*\{[^}]*animation-fill-mode/s,
  );

  await act(async () => {
    store.dispatch(setBridgeWait({ condition: "Waiting for bridge" }));
  });
  expect(
    container.querySelector('[data-testid="cukii-spinner-row"]'),
  ).toBeNull();
  expect(
    container.querySelector('[data-testid="cukii-waiting-receipt"]'),
  ).not.toBeNull();

  await act(async () => {
    store.dispatch(setBridgeWait(undefined));
    store.dispatch(
      setCodeToEdit({
        codeToEdit: { filepath: "D:/Scratch/example.ts", contents: "" },
      }),
    );
    store.dispatch(setIsInEdit(true));
  });
  expect(
    container.querySelector('[data-testid="cukii-spinner-row"]'),
  ).toBeNull();
  vi.useRealTimers();
});

test("Interrupted is a sibling timeline row, never a detached transcript footer", async () => {
  const { store, container } = await renderWithProviders(<Chat />);
  await act(async () => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "interrupted-rail",
        title: "Interrupted rail",
        history: [
          {
            message: { id: "user-1", role: "user", content: "Start" },
            contextItems: [],
          },
          {
            message: {
              id: "assistant-1",
              role: "assistant",
              content: "Partial result",
            },
            contextItems: [],
            interrupted: true,
          },
        ],
      },
    });
  });

  const interrupted = container.querySelector(
    "[data-testid='turn-interrupted']",
  );
  const row = interrupted?.closest(".cukii-timeline-item");
  expect(row).not.toBeNull();
  expect(row?.classList).toContain("cukii-timeline-event");
  expect(row?.classList).toContain("cukii-timeline-interrupted");
  expect(row?.previousElementSibling?.classList).toContain(
    "cukii-timeline-item",
  );
  expect(container.querySelector(".cukii-interrupted-fact")).toBeNull();
});

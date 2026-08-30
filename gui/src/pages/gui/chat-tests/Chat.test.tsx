import { act } from "@testing-library/react";
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
  setToolCallCalling,
} from "../../../redux/slices/sessionSlice";

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

test("tool start/start/complete race has exactly one active row and returns it to the terminal loader", async () => {
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
    1,
  );
  expect(
    container.querySelector('[data-cukii-active="true"]')?.textContent,
  ).toContain("Shell");

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

import { act } from "@testing-library/react";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import {
  getElementByTestId,
  getElementByText,
  sendInputWithMockedResponse,
} from "../../../util/test/utils";
import { Chat } from "../Chat";

test("should render input box", async () => {
  await renderWithProviders(<Chat />);
  await getElementByTestId("continue-input-box-main-editor-input");
});

test("should be able to toggle modes", async () => {
  await renderWithProviders(<Chat />);
  await getElementByText("Agent");

  // Simulate cmd+. keyboard shortcut to toggle modes
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ".",
        metaKey: true, // cmd key on Mac
      }),
    );
  });

  // Broker is the next mode after Agent.
  await getElementByText("Broker");

  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ".",
        metaKey: true, // cmd key on Mac
      }),
    );
  });

  // Then the cycle wraps to Chat.
  await getElementByText("Chat");

  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ".",
        metaKey: true, // cmd key on Mac
      }),
    );
  });

  await getElementByText("Plan");

  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ".",
        metaKey: true, // cmd key on Mac
      }),
    );
  });

  await getElementByText("Agent");
});

test("should send a message and receive a response", async () => {
  const { ideMessenger, store } = await renderWithProviders(<Chat />);

  // First add and select the mock LLM
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
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

test("shell tool calls stay compact captions and do not nest Terminal cards", async () => {
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
    container.querySelectorAll('[data-testid="tool-call-title"]'),
  ).toHaveLength(3);

  const timelineItems = container.querySelectorAll(".cukii-timeline-item");
  expect(timelineItems.length).toBeGreaterThanOrEqual(4);
  timelineItems.forEach((item) => {
    expect(item.querySelector(".cukii-timeline-item")).toBeNull();
  });
});

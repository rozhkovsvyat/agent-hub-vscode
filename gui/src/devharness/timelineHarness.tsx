// Dev-only harness: рендерит РЕАЛЬНЫЙ <Chat/> с mock-стором и синтетической
// историей (user / assistant-текст / assistant+tool / thinking), чтобы можно
// было открыть в браузере (Playwright) и ИЗМЕРИТЬ выравнивание точек таймлайна
// относительно первой строки каждой надписи. Не входит в прод-бандл.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { MainEditorProvider } from "../components/mainInput/TipTapEditor";
import { AuthProvider } from "../context/Auth";
import { IdeMessengerProvider } from "../context/IdeMessenger";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { Chat } from "../pages/gui/Chat";
import { setupStore } from "../redux/store";
import "../index.css";

const ideMessenger = new MockIdeMessenger();
const store = setupStore({ ideMessenger });
const RECEIPT_SENT_AT = 1_700_000_000_000;
const HARNESS_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='96'%3E%3Crect width='180' height='96' fill='%235a6b7c'/%3E%3C/svg%3E";

const HISTORY = [
  {
    message: {
      id: "receipt-short-sent",
      role: "user",
      content: "Ship it",
    },
    contextItems: [],
    isSteer: true,
    steerStatus: "delivered",
    steerSentAt: RECEIPT_SENT_AT,
  },
  {
    message: {
      id: "receipt-long-read",
      role: "user",
      content:
        "A long one-line follow-up keeps every word visible at the narrow 320px viewport without the time or read state covering its final word.",
    },
    contextItems: [],
    isSteer: true,
    steerStatus: "read",
    steerSentAt: RECEIPT_SENT_AT,
  },
  {
    message: {
      id: "receipt-multiline-read",
      role: "user",
      content:
        "First deliberate line\nSecond deliberate line\nFinal deliberate line",
    },
    contextItems: [],
    isSteer: true,
    steerStatus: "read",
    steerSentAt: RECEIPT_SENT_AT,
  },
  {
    message: {
      id: "receipt-image-sent",
      role: "user",
      content: "Image attachment",
    },
    contextItems: [],
    editorState: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Image attachment" }],
        },
        { type: "image", attrs: { src: HARNESS_IMAGE } },
      ],
    },
    isSteer: true,
    steerStatus: "delivered",
    steerSentAt: RECEIPT_SENT_AT,
  },
  {
    message: {
      id: "receipt-call-style-read",
      role: "user",
      content: "run_live_harness()",
    },
    contextItems: [],
    editorState: {
      type: "doc",
      content: [
        {
          type: "code-block",
          attrs: {
            inputId: "receipt-call-style-read",
            item: {
              id: { providerTitle: "code", itemId: "receipt-call-style" },
              name: "receipt-call.ts",
              description: "1-1",
              content: "run_live_harness()",
              uri: { type: "file", value: "file:///receipt-call.ts" },
            },
          },
        },
      ],
    },
    isSteer: true,
    steerStatus: "read",
    steerSentAt: RECEIPT_SENT_AT,
  },
  {
    message: {
      id: "assistant-1",
      role: "assistant",
      content:
        "Sure — let me search the repository for the pattern, then run the suite.",
    },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: "tool-1",
        toolCall: {
          id: "tool-1",
          type: "function",
          function: {
            name: "run_terminal_command",
            arguments:
              '{"command":"Get-Content C:/workspace/a/very/long/path/to/a/file.ts"}',
          },
        },
        status: "done",
        parsedArgs: {
          command: "Get-Content C:/workspace/a/very/long/path/to/a/file.ts",
        },
        output: [
          {
            name: "Terminal",
            description: "stdout",
            content: "file contents",
          },
        ],
      },
    ],
    interrupted: true,
  },
  {
    message: {
      id: "thinking-1",
      role: "thinking",
      content: "Considering how the timeline dots line up with each label.",
    },
    contextItems: [],
  },
  {
    message: {
      id: "assistant-2",
      role: "assistant",
      content: "Done. The checks pass and the dots should line up now.",
    },
    contextItems: [],
  },
];

function Harness() {
  const [, setReady] = useState(false);
  useEffect(() => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "timeline-harness",
        title: "Timeline harness",
        history: HISTORY,
      },
    });
    // Chat's own effects settle immediately after mount. Schedule the fixture
    // state after them so CDP measures a real live loader, not an idle shell.
    const activate = window.setTimeout(
      () => store.dispatch({ type: "session/setActive" }),
      0,
    );
    setReady(true);
    return () => window.clearTimeout(activate);
  }, []);
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <Chat />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <IdeMessengerProvider messenger={ideMessenger}>
      <Provider store={store}>
        <AuthProvider>
          <MainEditorProvider>
            <Harness />
          </MainEditorProvider>
        </AuthProvider>
      </Provider>
    </IdeMessengerProvider>
  </MemoryRouter>,
);

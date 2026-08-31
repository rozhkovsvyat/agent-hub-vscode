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
import ParallelListeners from "../hooks/ParallelListeners";
import { Chat } from "../pages/gui/Chat";
import { setupStore } from "../redux/store";
import "../index.css";

const ideMessenger = new MockIdeMessenger();
const store = setupStore({ ideMessenger });

const HISTORY = [
  {
    message: {
      id: "user-1",
      role: "user",
      content: "Search the repo and run the checks",
    },
    contextItems: [],
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
    setReady(true);
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
            <ParallelListeners />
          </MainEditorProvider>
        </AuthProvider>
      </Provider>
    </IdeMessengerProvider>
  </MemoryRouter>,
);

// Dev-only visual fixture for Claude-style sticky user turns. Not imported by
// the production bundle.
import { useEffect } from "react";
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
const SENT_AT = 1_700_000_000_000;
const LONG_ANSWER =
  "This response is intentionally long so its prompt remains pinned while the reader moves through the turn. ".repeat(
    22,
  );
const LONG_PROMPT =
  "A long user prompt demonstrates Claude's sixty-pixel fold. Its delivery footer must remain visible below the clipped content, including the timestamp and read checks. ".repeat(
    5,
  );

const HISTORY = [
  {
    message: { id: "sticky-first", role: "user", content: "First prompt" },
    contextItems: [],
    messageReceipt: { sentAt: SENT_AT, status: "read" },
  },
  {
    message: { id: "answer-first", role: "assistant", content: LONG_ANSWER },
    contextItems: [],
  },
  {
    message: { id: "sticky-long", role: "user", content: LONG_PROMPT },
    contextItems: [],
    messageReceipt: { sentAt: SENT_AT + 60_000, status: "read" },
  },
  {
    message: { id: "answer-long", role: "assistant", content: LONG_ANSWER },
    contextItems: [],
  },
  {
    message: { id: "sticky-last", role: "user", content: "Latest prompt" },
    contextItems: [],
    messageReceipt: { sentAt: SENT_AT + 120_000, status: "delivered" },
  },
  {
    message: { id: "answer-last", role: "assistant", content: LONG_ANSWER },
    contextItems: [],
  },
];

function Harness() {
  useEffect(() => {
    store.dispatch({
      type: "session/newSession",
      payload: {
        sessionId: "sticky-message-harness",
        title: "Sticky message harness",
        history: HISTORY,
      },
    });
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        maxWidth: 720,
        height: "100%",
        margin: "0 auto",
        overflow: "hidden",
        position: "relative",
      }}
    >
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

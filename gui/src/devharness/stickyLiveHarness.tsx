// Dev-only LIVE streaming fixture: replays a real saved session incrementally
// (newSession -> streamUpdate per item) so scroll behaviour can be measured
// while the transcript grows, as during a real agent run. Not production code.
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

declare global {
  interface Window {
    __live?: {
      appendNext: (count: number) => number;
      finish: () => void;
      remaining: () => number;
    };
  }
}

const ideMessenger = new MockIdeMessenger();
const store = setupStore({ ideMessenger });

function Harness() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    fetch("/session-fixture.json")
      .then((res) => res.json())
      .then((fixture) => {
        const history = fixture.history as any[];
        const initialCount = 12;
        const initial = history.slice(0, initialCount);
        let cursor = initialCount;
        store.dispatch({
          type: "session/newSession",
          payload: {
            sessionId: fixture.sessionId,
            title: fixture.title,
            history: initial,
          },
        });
        store.dispatch({ type: "session/setActive" });
        window.__live = {
          appendNext: (count: number) => {
            const chunk = history.slice(cursor, cursor + count);
            cursor += count;
            if (chunk.length) {
              store.dispatch({
                type: "session/streamUpdate",
                payload: chunk.map((item: any) => item.message ?? item),
              });
            }
            return chunk.length;
          },
          finish: () => {
            store.dispatch({ type: "session/setInactive" });
          },
          remaining: () => history.length - cursor,
        };
        setLoaded(true);
      });
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        maxWidth: 860,
        height: "100%",
        margin: "0 auto",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {loaded ? <Chat /> : <div>loading session…</div>}
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

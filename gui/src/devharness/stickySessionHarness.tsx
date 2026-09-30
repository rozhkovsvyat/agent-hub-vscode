// Dev-only visual fixture that replays a REAL saved Cukii session (exported
// from history.sqlite3 to public/session-fixture.json). Not imported by the
// production bundle.
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
ideMessenger.responses["cukii/getIssueReportCapability"] = {
  available: true,
  reason: "available",
  accountLabel: "acceptance@example.test",
};
const store = setupStore({ ideMessenger });
// Dev-only handle for CDP-driven visual checks (question sheet, reactions).
(window as any).__store = store;

function Harness() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    fetch("/session-fixture.json")
      .then((res) => res.json())
      .then((fixture) => {
        store.dispatch({
          type: "session/newSession",
          payload: {
            sessionId: fixture.sessionId,
            title: fixture.title,
            history: fixture.history,
          },
        });
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

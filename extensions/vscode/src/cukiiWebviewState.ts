const LEGACY_HISTORY_STATE_KEYS = [
  "page",
  "path",
  "pathname",
  "route",
  "currentPage",
] as const;

/**
 * Runs before the GUI module on every new or revived webview. Older Cukii
 * builds persisted their full-screen history route in VS Code webview state;
 * retaining that opaque state let the removed editor take over a chat tab
 * after restart. Keep session/title/drafts, but consume route-only state once.
 */
export function getCukiiWebviewStateBootstrap(initialSessionId?: string) {
  const serializedSessionId = JSON.stringify(initialSessionId ?? null).replace(
    /</g,
    "\\u003c",
  );
  const serializedKeys = JSON.stringify(LEGACY_HISTORY_STATE_KEYS);

  return `(() => {
    const restoredState = window.cukiiVscode.getState() || {};
    const migratedState = { ...restoredState };
    for (const key of ${serializedKeys}) delete migratedState[key];
    if (window.location.pathname === "/history") {
      window.history.replaceState(null, "", "/");
    }
    window.initialSessionId = ${serializedSessionId} || migratedState.sessionId || null;
    window.cukiiVscode.setState({ ...migratedState, sessionId: window.initialSessionId });
  })();`;
}

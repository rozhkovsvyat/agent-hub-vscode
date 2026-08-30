/** A strict matcher: similarly named routes must not lose their state. */
export function isLegacyHistoryRoute(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let route = value.trim().toLowerCase().split(/[?#]/, 1)[0];
  route = route.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/, "");
  route = route.replace(/\/+$/, "");
  return route === "/history" || route === "history";
}

/**
 * Clone JSON-like VS Code webview state while consuming only fields whose
 * value is the removed history route. The depth cap and WeakMap make this
 * safe even when a test/host hands us non-serializable state.
 *
 * Keep this function self-contained: its source is embedded into the webview
 * bootstrap below so the tested implementation and runtime implementation
 * cannot drift.
 */
export function sanitizeLegacyHistoryState(
  input: unknown,
  maxDepth = 12,
): unknown {
  const seen = new WeakMap<object, unknown>();
  const depthLimit = Number.isFinite(maxDepth)
    ? Math.max(0, Math.floor(maxDepth))
    : 12;
  const routeFieldNames = new Set([
    "page",
    "path",
    "pathname",
    "route",
    "currentpage",
    "url",
    "href",
  ]);
  const pointsToLegacyHistory = (value: unknown) => {
    if (typeof value !== "string") return false;
    let route = value.trim().toLowerCase().split(/[?#]/, 1)[0];
    route = route.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/, "");
    route = route.replace(/\/+$/, "");
    return route === "/history" || route === "history";
  };

  const visit = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value !== "object") return value;
    const known = seen.get(value);
    if (known !== undefined) return known;

    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      return value;
    }

    const clone: Record<string, unknown> | unknown[] = isArray
      ? []
      : Object.create(prototype === null ? null : Object.prototype);
    seen.set(value, clone);

    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // Do not execute getters from untrusted/prototyped state.
      if (!descriptor || !("value" in descriptor)) continue;
      const fieldValue = descriptor.value as unknown;
      const lowerKey = key.toLowerCase();
      if (
        routeFieldNames.has(lowerKey) &&
        pointsToLegacyHistory(fieldValue)
      ) {
        continue;
      }

      const sanitized =
        depth >= depthLimit ? fieldValue : visit(fieldValue, depth + 1);
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: sanitized,
        writable: true,
      });
    }
    return clone;
  };

  return visit(input, 0);
}

/** Runs before the GUI module on every new or revived webview. */
export function getCukiiWebviewStateBootstrap(initialSessionId?: string) {
  const serializedSessionId = JSON.stringify(initialSessionId ?? null).replace(
    /</g,
    "\\u003c",
  );
  return `(() => {
    const sanitizeLegacyHistoryState = ${sanitizeLegacyHistoryState.toString()};
    const isLegacyHistoryRoute = ${isLegacyHistoryRoute.toString()};
    const restoredState = window.cukiiVscode.getState() || {};
    const sanitizedState = sanitizeLegacyHistoryState(restoredState);
    const migratedState = sanitizedState && typeof sanitizedState === "object" &&
      !Array.isArray(sanitizedState) ? sanitizedState : {};
    const locationRoute = String(window.location.pathname || "") +
      String(window.location.search || "") + String(window.location.hash || "");
    if (isLegacyHistoryRoute(locationRoute)) {
      window.history.replaceState(null, "", "/");
    }
    const serializedSessionId = ${serializedSessionId};
    window.initialSessionId = serializedSessionId ?? migratedState.sessionId ?? null;
    window.cukiiVscode.setState({ ...migratedState, sessionId: window.initialSessionId });
  })();`;
}

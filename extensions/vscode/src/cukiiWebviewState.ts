import { isLegacyHistoryRoute } from "core/util/legacyHistoryRoute";

export { isLegacyHistoryRoute } from "core/util/legacyHistoryRoute";

/**
 * Clone JSON-like VS Code webview state while consuming only fields whose
 * value is the removed history route. An iterative worklist and WeakMap make
 * deeply nested or cyclic non-serializable test/host state safe as well.
 *
 * Keep this function self-contained: its source is embedded into the webview
 * bootstrap below so the tested implementation and runtime implementation
 * cannot drift.
 */
export function sanitizeLegacyHistoryState(
  input: unknown,
  pointsToLegacyHistory: (value: unknown) => boolean = isLegacyHistoryRoute,
): unknown {
  const seen = new WeakMap<object, unknown>();
  const routeFieldNames = new Set([
    "page",
    "path",
    "pathname",
    "route",
    "currentpage",
    "url",
    "href",
  ]);
  const createClone = (
    value: object,
  ): Record<string, unknown> | unknown[] | null => {
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    return isArray
      ? []
      : Object.create(prototype === null ? null : Object.prototype);
  };

  if (input === null || typeof input !== "object") return input;
  const root = createClone(input);
  if (root === null) return input;
  seen.set(input, root);
  const pending: Array<{
    source: object;
    target: Record<string, unknown> | unknown[];
  }> = [{ source: input, target: root }];

  while (pending.length > 0) {
    const { source, target } = pending.pop()!;
    for (const key of Object.keys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      // Do not execute getters from untrusted/prototyped state.
      if (!descriptor || !("value" in descriptor)) continue;
      const fieldValue = descriptor.value as unknown;
      const lowerKey = key.toLowerCase();
      if (routeFieldNames.has(lowerKey) && pointsToLegacyHistory(fieldValue)) {
        continue;
      }

      let sanitized = fieldValue;
      if (fieldValue !== null && typeof fieldValue === "object") {
        const known = seen.get(fieldValue);
        if (known !== undefined) {
          sanitized = known;
        } else {
          const childClone = createClone(fieldValue);
          if (childClone !== null) {
            sanitized = childClone;
            seen.set(fieldValue, childClone);
            pending.push({ source: fieldValue, target: childClone });
          }
        }
      }
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value: sanitized,
        writable: true,
      });
    }
  }

  return root;
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
    const sanitizedState = sanitizeLegacyHistoryState(restoredState, isLegacyHistoryRoute);
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

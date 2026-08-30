import { describe, expect, it, vi } from "vitest";

import {
  getCukiiWebviewStateBootstrap,
  isLegacyHistoryRoute,
  sanitizeLegacyHistoryState,
} from "./cukiiWebviewState";

function runBootstrap(
  restoredState: unknown,
  initialSessionId?: string,
  location: { hash?: string; pathname: string; search?: string } = {
    pathname: "/history",
  },
) {
  const setState = vi.fn();
  const replaceState = vi.fn();
  const fakeWindow = {
    cukiiVscode: { getState: () => restoredState, setState },
    initialSessionId: undefined as string | null | undefined,
    location: { hash: "", search: "", ...location },
    history: { replaceState },
  };

  new Function("window", getCukiiWebviewStateBootstrap(initialSessionId))(
    fakeWindow,
  );
  return { fakeWindow, replaceState, setState };
}

describe("revived Cukii webview legacy route migration", () => {
  it("retains the exact restored chat while consuming legacy route state", () => {
    const { fakeWindow, replaceState, setState } = runBootstrap({
      sessionId: "saved-session",
      title: "Saved title",
      cukiiBrokerDraft: "unfinished input",
      page: "/history",
      path: "/history",
      pathname: "/history",
      route: { pathname: "/history" },
      currentPage: "history",
    });

    expect(fakeWindow.initialSessionId).toBe("saved-session");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(setState).toHaveBeenCalledWith({
      sessionId: "saved-session",
      title: "Saved title",
      cukiiBrokerDraft: "unfinished input",
      route: {},
    });
  });

  it("lets the serializer's exact session win without losing persisted title", () => {
    const { fakeWindow, setState } = runBootstrap(
      {
        sessionId: "stale-session",
        title: "Restored title",
        page: "/history",
      },
      "serializer-session",
    );

    expect(fakeWindow.initialSessionId).toBe("serializer-session");
    expect(setState).toHaveBeenCalledWith({
      sessionId: "serializer-session",
      title: "Restored title",
    });
  });

  it.each([
    "/History",
    "/history/",
    "/HISTORY/?from=restore",
    "/history#old",
    "history?old=true#route",
    "vscode-webview://panel/History/",
  ])("normalizes the legacy route variant %s", (route) => {
    expect(isLegacyHistoryRoute(route)).toBe(true);
  });

  it("removes case-insensitive and nested history routes only", () => {
    const original = {
      Page: "/History",
      path: "/config",
      navigation: { pathname: "/history/?restored=1#old" },
      config: {
        path: "/config",
        route: { pathname: "/settings", mode: "advanced" },
      },
      history: [{ role: "user", content: "keep chat history" }],
      title: "Keep title",
      cukiiBrokerDraft: "Keep draft",
    };

    const migrated = sanitizeLegacyHistoryState(original);

    expect(migrated).toEqual({
      path: "/config",
      navigation: {},
      config: {
        path: "/config",
        route: { pathname: "/settings", mode: "advanced" },
      },
      history: [{ role: "user", content: "keep chat history" }],
      title: "Keep title",
      cukiiBrokerDraft: "Keep draft",
    });
    expect(original.Page).toBe("/History");
    expect(original.navigation.pathname).toContain("/history/");
  });

  it("preserves unrelated empty route and navigation containers", () => {
    expect(
      sanitizeLegacyHistoryState({ route: {}, navigation: {}, path: "/config" }),
    ).toEqual({ route: {}, navigation: {}, path: "/config" });
  });

  it("migrates a mixed-case URL and preserves unrelated state in bootstrap", () => {
    const { replaceState, setState } = runBootstrap(
      {
        sessionId: "saved-session",
        Page: "/History",
        path: "/config",
        route: { pathname: "/config", tab: "accounts" },
      },
      undefined,
      { pathname: "/History/", search: "?old=1", hash: "#restore" },
    );

    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(setState).toHaveBeenCalledWith({
      sessionId: "saved-session",
      path: "/config",
      route: { pathname: "/config", tab: "accounts" },
    });
  });

  it("handles cycles, arrays, primitives, null prototypes and a depth cap", () => {
    const cyclic: Record<string, unknown> = {
      items: [{ Path: "/history#old" }, 7, null, "text"],
    };
    cyclic.self = cyclic;
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nullPrototype, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    nullPrototype.pathname = "/config";
    cyclic.nullPrototype = nullPrototype;
    let deep: Record<string, unknown> = cyclic;
    for (let index = 0; index < 50; index++) deep = { navigation: deep };

    const migrated = sanitizeLegacyHistoryState(deep, 4) as Record<
      string,
      unknown
    >;
    expect(() => sanitizeLegacyHistoryState(deep, Infinity)).not.toThrow();
    const migratedCycle = sanitizeLegacyHistoryState(cyclic) as Record<
      string,
      unknown
    >;

    expect(migrated).toBeDefined();
    expect(migratedCycle.self).toBe(migratedCycle);
    expect(migratedCycle.items).toEqual([{}, 7, null, "text"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(
      (migratedCycle.nullPrototype as Record<string, unknown>).pathname,
    ).toBe("/config");
  });

  it.each([null, "not-state", 42, ["not", "state"]])(
    "normalizes non-object bootstrap state %j without throwing",
    (restoredState) => {
      const { fakeWindow, setState } = runBootstrap(restoredState);

      expect(fakeWindow.initialSessionId).toBeNull();
      expect(setState).toHaveBeenCalledWith({ sessionId: null });
    },
  );

  it("keeps even an empty explicitly serialized session id authoritative", () => {
    const { fakeWindow, setState } = runBootstrap(
      { sessionId: "stale-session", title: "Keep" },
      "",
    );

    expect(fakeWindow.initialSessionId).toBe("");
    expect(setState).toHaveBeenCalledWith({ sessionId: "", title: "Keep" });
  });
});

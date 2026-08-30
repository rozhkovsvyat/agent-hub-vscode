import { describe, expect, it, vi } from "vitest";

import { getCukiiWebviewStateBootstrap } from "./cukiiWebviewState";

function runBootstrap(
  restoredState: Record<string, unknown>,
  initialSessionId?: string,
) {
  const setState = vi.fn();
  const replaceState = vi.fn();
  const fakeWindow = {
    cukiiVscode: { getState: () => restoredState, setState },
    initialSessionId: undefined as string | null | undefined,
    location: { pathname: "/history" },
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
});

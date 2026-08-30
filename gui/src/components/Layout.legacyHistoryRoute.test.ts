import { describe, expect, it, vi } from "vitest";

import { redirectLegacyHistoryNavigation } from "./Layout";

describe("Layout legacy history navigation", () => {
  it.each([
    "/History/",
    "/history?source=layout#old",
    "history/",
    "https://cukii.test/HISTORY/?source=layout#old",
    "vscode-webview://panel/History/#old",
  ])("redirects the legacy route variant %s", (route) => {
    const navigate = vi.fn();

    expect(redirectLegacyHistoryNavigation(route, navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("does not redirect similarly named current routes", () => {
    const navigate = vi.fn();

    expect(redirectLegacyHistoryNavigation("/history-settings", navigate)).toBe(
      false,
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});

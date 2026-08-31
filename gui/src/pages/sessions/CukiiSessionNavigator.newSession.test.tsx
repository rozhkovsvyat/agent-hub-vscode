import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import CukiiSessionNavigator from "./CukiiSessionNavigator";

describe("CukiiSessionNavigator new session routing", () => {
  it("forwards every click as an independent forceNew panel request", async () => {
    const messenger = new MockIdeMessenger();
    const openChatPanel = vi.fn().mockResolvedValue(undefined);
    messenger.responseHandlers["cukii/openChatPanel"] = openChatPanel;
    messenger.responses["history/list"] = [];
    messenger.responses["cukii/listOpenChatPanels"] = [];

    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });

    const newSession = screen.getByRole("button", { name: "New session" });
    fireEvent.click(newSession);
    fireEvent.click(newSession);

    await waitFor(() => expect(openChatPanel).toHaveBeenCalledTimes(2));
    expect(openChatPanel).toHaveBeenNthCalledWith(1, { forceNew: true });
    expect(openChatPanel).toHaveBeenNthCalledWith(2, { forceNew: true });
  });
});

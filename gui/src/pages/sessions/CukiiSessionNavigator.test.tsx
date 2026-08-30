import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import CukiiSessionNavigator from "./CukiiSessionNavigator";

describe("CukiiSessionNavigator Claude parity", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      "cukii.session-groups.v1",
      JSON.stringify({
        groups: [{ id: "plugin", name: "Плагин" }],
        assignments: {},
      }),
    );
  });

  it("uses relative time and a custom context menu without native selects", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responses["history/list"] = [
      {
        sessionId: "session",
        title: "привет - продолжим?",
        dateCreated: "not-a-date",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [
      {
        panelId: "panel",
        sessionId: "session",
        title: "привет - продолжим?",
      },
    ];

    const { container } = await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });
    const session = await screen.findByTitle("привет - продолжим?");

    expect(container.textContent).not.toContain("NaNd");
    expect(container.textContent).not.toContain("open");
    expect(container.querySelector("select")).toBeNull();

    fireEvent.contextMenu(session, { clientX: 120, clientY: 160 });
    expect(
      await screen.findByRole("menu", {
        name: "Session actions for привет - продолжим?",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Rename session" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete session" }),
    ).toBeInTheDocument();
    expect(screen.getByText('Move to "Плагин"')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("menu", {
        name: "Session actions for привет - продолжим?",
      }),
    ).not.toBeInTheDocument();
  });

  it("renders no sidebar rows for blank open panels", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responses["history/list"] = [];
    messenger.responses["cukii/listOpenChatPanels"] = Array.from(
      { length: 10 },
      (_, index) => ({
        panelId: `panel-${index}`,
        title: "Cukii",
      }),
    );

    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });

    expect(screen.queryByRole("button", { name: /Cukii/i })).toBeNull();
    expect(screen.getByText("No sessions found")).toBeInTheDocument();
  });

  it("opens the clicked saved session by its exact sessionId and existing panel id", async () => {
    const messenger = new MockIdeMessenger();
    const openSpy = vi.fn().mockResolvedValue(undefined);
    messenger.responseHandlers["cukii/openChatPanel"] = openSpy;
    messenger.responses["history/list"] = [
      {
        sessionId: "saved-session",
        title: "Restore my history",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [
      {
        panelId: "existing-panel",
        sessionId: "saved-session",
        title: "Restore my history",
      },
    ];

    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });
    const button = await screen.findByTitle("Restore my history");
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() =>
      expect(openSpy).toHaveBeenNthCalledWith(1, {
        panelId: "existing-panel",
        sessionId: "saved-session",
        title: "Restore my history",
      }),
    );
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(openSpy).toHaveBeenNthCalledWith(2, {
      panelId: "existing-panel",
      sessionId: "saved-session",
      title: "Restore my history",
    });
  });

  it("persists sidebar rename through cukii/renameSession", async () => {
    const messenger = new MockIdeMessenger();
    const renameSpy = vi.fn().mockResolvedValue({ ok: true });
    messenger.responseHandlers["cukii/renameSession"] = renameSpy;
    messenger.responses["history/list"] = [
      {
        sessionId: "session",
        title: "Old title",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [];

    vi.stubGlobal(
      "prompt",
      vi.fn(() => "Manual title"),
    );

    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });

    fireEvent.contextMenu(await screen.findByTitle("Old title"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Rename session" }),
    );

    await waitFor(() =>
      expect(renameSpy).toHaveBeenCalledWith({
        sessionId: "session",
        title: "Manual title",
      }),
    );
  });

  it("does nothing when sidebar rename is cancelled or empty", async () => {
    const messenger = new MockIdeMessenger();
    const renameSpy = vi.fn();
    messenger.responseHandlers["cukii/renameSession"] = renameSpy;
    messenger.responses["history/list"] = [
      {
        sessionId: "session",
        title: "Keep me",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [];

    vi.stubGlobal(
      "prompt",
      vi.fn(() => "   "),
    );

    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });
    fireEvent.click(await screen.findByLabelText("Rename Keep me"));
    expect(renameSpy).not.toHaveBeenCalled();
  });
});

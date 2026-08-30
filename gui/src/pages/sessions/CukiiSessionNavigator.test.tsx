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
      screen.queryByRole("menuitem", { name: "Rename session" }),
    ).toBeNull();
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

  it("persists pencil rename and updates sidebar and open-tab metadata without a reload", async () => {
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
    messenger.responses["cukii/listOpenChatPanels"] = [
      { panelId: "panel", sessionId: "session", title: "Old title" },
    ];
    const openSpy = vi.fn().mockResolvedValue(undefined);
    messenger.responseHandlers["cukii/openChatPanel"] = openSpy;

    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });

    fireEvent.click(await screen.findByLabelText("Rename Old title"));
    const input = await screen.findByLabelText("Rename Old title");
    expect(input.closest("button")).toBeNull();
    fireEvent.change(input, { target: { value: "Manual title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(renameSpy).toHaveBeenCalledWith({
        sessionId: "session",
        title: "Manual title",
      }),
    );
    expect(await screen.findByTitle("Manual title")).toBeInTheDocument();
    expect(screen.queryAllByTitle("Manual title")).toHaveLength(1);
    fireEvent.click(screen.getByTitle("Manual title"));
    expect(openSpy).toHaveBeenCalledWith({
      panelId: "panel",
      sessionId: "session",
      title: "Manual title",
    });
    expect(renameSpy).toHaveBeenCalledTimes(1);
  });

  it("saves a non-empty rename on blur", async () => {
    const messenger = new MockIdeMessenger();
    const renameSpy = vi.fn().mockResolvedValue({ ok: true });
    messenger.responseHandlers["cukii/renameSession"] = renameSpy;
    messenger.responses["history/list"] = [
      {
        sessionId: "session",
        title: "Before blur",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [];
    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });
    fireEvent.click(await screen.findByLabelText("Rename Before blur"));
    const input = await screen.findByLabelText("Rename Before blur");
    fireEvent.change(input, { target: { value: "After blur" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(renameSpy).toHaveBeenCalledWith({
        sessionId: "session",
        title: "After blur",
      }),
    );
    expect(await screen.findByTitle("After blur")).toBeInTheDocument();
  });

  it("does nothing when sidebar rename is escaped or empty", async () => {
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

    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });
    fireEvent.click(await screen.findByLabelText("Rename Keep me"));
    let input = await screen.findByLabelText("Rename Keep me");
    fireEvent.change(input, { target: { value: "Discard me" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByTitle("Keep me")).toBeInTheDocument();
    expect(renameSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Rename Keep me"));
    input = await screen.findByLabelText("Rename Keep me");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("rolls back to the persisted title and shows an honest error if persistence fails", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["cukii/renameSession"] = vi
      .fn()
      .mockResolvedValue({ ok: false });
    messenger.responses["history/list"] = [
      {
        sessionId: "session",
        title: "Old title",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [];
    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });
    fireEvent.click(await screen.findByLabelText("Rename Old title"));
    const input = await screen.findByLabelText("Rename Old title");
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not rename session");
    expect(screen.queryByDisplayValue("New title")).toBeNull();
    expect(screen.getByTitle("Old title")).toBeInTheDocument();
  });
});

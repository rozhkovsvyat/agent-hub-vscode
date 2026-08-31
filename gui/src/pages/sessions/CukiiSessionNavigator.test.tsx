import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import CukiiSessionNavigator, {
  formatSessionAge,
} from "./CukiiSessionNavigator";

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

  it("uses the exact Claude group-menu order and persists rename/delete actions", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responses["history/list"] = [
      {
        sessionId: "session",
        title: "Grouped session",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [];
    localStorage.setItem(
      "cukii.session-groups.v1",
      JSON.stringify({
        groups: [{ id: "plugin", name: "Плагин" }],
        assignments: { session: "plugin" },
      }),
    );

    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });
    const header = await screen.findByRole("button", { name: "Плагин 1" });
    fireEvent.contextMenu(header, { clientX: 120, clientY: 160 });
    const menu = await screen.findByRole("menu", {
      name: "Group actions for Плагин",
    });
    expect(
      Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
        (item) => item.textContent,
      ),
    ).toEqual(["New group", "Rename group", "Delete group"]);
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);

    fireEvent.click(screen.getByRole("menuitem", { name: "New group" }));
    const newGroupInput = await screen.findByLabelText("Group name");
    expect(newGroupInput).toBeInTheDocument();
    fireEvent.keyDown(newGroupInput, { key: "Escape" });

    fireEvent.contextMenu(header, { clientX: 120, clientY: 160 });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Rename group" }),
    );
    const input = await screen.findByLabelText("Rename group Плагин");
    fireEvent.change(input, { target: { value: "Extensions" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      await screen.findByRole("button", { name: "Extensions 1" }),
    ).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem("cukii.session-groups.v1") ?? "{}"),
    ).toEqual(
      expect.objectContaining({
        groups: [{ id: "plugin", name: "Extensions" }],
        assignments: { session: "plugin" },
      }),
    );

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Extensions 1" }),
      { clientX: 120, clientY: 160 },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete group" }),
    );
    expect(screen.queryByRole("button", { name: "Extensions 1" })).toBeNull();
    expect(screen.getByTitle("Grouped session")).toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem("cukii.session-groups.v1") ?? "{}"),
    ).toEqual(expect.objectContaining({ groups: [], assignments: {} }));
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

  it("reserves an accessible action rail so a long title truncates before the icons", async () => {
    const title =
      "A very long saved Cukii session title that must never cover its actions";
    localStorage.setItem(
      "cukii.session-groups.v1",
      JSON.stringify({
        groups: [{ id: "plugin", name: "Плагин" }],
        assignments: { long: "plugin" },
      }),
    );
    const messenger = new MockIdeMessenger();
    messenger.responses["history/list"] = [
      {
        sessionId: "long",
        title,
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [];

    const { container } = await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });
    const navigator = screen.getByTestId("cukii-session-navigator");
    navigator.style.width = "160px";
    const trigger = await screen.findByTitle(title);
    const row = trigger.closest(".cukii-session-row");
    const sessionTitle = trigger.querySelector(".cukii-session-title");
    const actions = row?.querySelector(".cukii-session-actions");

    expect(container.querySelectorAll(".cukii-session-row")).toHaveLength(1);
    expect(row).toHaveClass("cukii-session-row");
    expect(sessionTitle).toHaveClass("cukii-session-title");
    expect(actions).toHaveClass("cukii-session-actions");
    expect(getComputedStyle(sessionTitle!).minWidth).toBe("0");
    expect(getComputedStyle(sessionTitle!).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(actions!).width).toBe("56px");
    expect(
      screen.getByText(formatSessionAge("2026-08-27T12:00:00Z")),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Плагин 1" }),
    ).toBeInTheDocument();

    const rename = screen.getByLabelText(`Rename ${title}`);
    const remove = screen.getByLabelText(`Delete ${title}`);
    expect(rename).toBeVisible();
    expect(remove).toBeVisible();
    fireEvent.click(rename);
    expect(await screen.findByLabelText(`Rename ${title}`)).toHaveValue(title);
    expect(screen.queryByTitle("Rename session")).toBeNull();
    expect(screen.queryByTitle("Delete session")).toBeNull();
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

  it("accepts repeated session renames A→B→C→D without retaining a stale draft", async () => {
    const messenger = new MockIdeMessenger();
    const renameSpy = vi.fn().mockResolvedValue({ ok: true });
    messenger.responseHandlers["cukii/renameSession"] = renameSpy;
    messenger.responses["history/list"] = [
      {
        sessionId: "session",
        title: "A",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [
      { panelId: "panel", sessionId: "session", title: "A" },
    ];
    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });

    for (const [from, to] of [
      ["A", "B"],
      ["B", "C"],
      ["C", "D"],
    ] as const) {
      fireEvent.click(await screen.findByLabelText(`Rename ${from}`));
      const input = await screen.findByLabelText(`Rename ${from}`);
      fireEvent.change(input, { target: { value: to } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByTitle(to)).toBeInTheDocument();
    }

    expect(renameSpy).toHaveBeenNthCalledWith(1, {
      sessionId: "session",
      title: "B",
    });
    expect(renameSpy).toHaveBeenNthCalledWith(2, {
      sessionId: "session",
      title: "C",
    });
    expect(renameSpy).toHaveBeenNthCalledWith(3, {
      sessionId: "session",
      title: "D",
    });
    expect(renameSpy).toHaveBeenCalledTimes(3);
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
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not rename session",
    );
    expect(screen.queryByDisplayValue("New title")).toBeNull();
    expect(screen.getByTitle("Old title")).toBeInTheDocument();
  });

  it("removes a session immediately while its disk deletion is still pending", async () => {
    const messenger = new MockIdeMessenger();
    let resolveDelete: (() => void) | undefined;
    const deleteSpy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = () => {
            messenger.responses["history/list"] = [
              {
                sessionId: "before",
                title: "Before",
                dateCreated: "2026-08-27T12:00:00Z",
                workspaceDirectory: "D:/Brain/vault",
              },
              {
                sessionId: "after",
                title: "After",
                dateCreated: "2026-08-27T12:00:00Z",
                workspaceDirectory: "D:/Brain/vault",
              },
            ];
            resolve();
          };
        }),
    );
    messenger.responseHandlers["history/delete"] = deleteSpy;
    const openSpy = vi.fn().mockResolvedValue(undefined);
    messenger.responseHandlers["cukii/openChatPanel"] = openSpy;
    messenger.responses["history/list"] = [
      {
        sessionId: "before",
        title: "Before",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
      {
        sessionId: "delete-me",
        title: "Delete me",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
      {
        sessionId: "after",
        title: "After",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [
      { panelId: "active-panel", sessionId: "delete-me", title: "Delete me" },
    ];

    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });

    const deleteButton = await screen.findByLabelText("Delete Delete me");
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);

    await waitFor(() =>
      expect(deleteSpy).toHaveBeenCalledWith({ id: "delete-me" }),
    );
    expect(screen.queryByTitle("Delete me")).toBeNull();
    // Deletion must not re-open the row's already-active panel or create a
    // duplicate editor; its existing session lifecycle remains authoritative.
    expect(openSpy).not.toHaveBeenCalled();
    expect(
      screen.getAllByTitle(/Before|After/).map((node) => node.title),
    ).toEqual(["Before", "After"]);
    expect(resolveDelete).toBeDefined();
    resolveDelete?.();
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTitle("Delete me")).toBeNull());
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("restores the deleted row, order, group, and one error if deletion fails", async () => {
    localStorage.setItem(
      "cukii.session-groups.v1",
      JSON.stringify({
        groups: [{ id: "plugin", name: "Плагин" }],
        assignments: { "delete-me": "plugin" },
      }),
    );
    const messenger = new MockIdeMessenger();
    const deleteSpy = vi.fn().mockRejectedValue(new Error("disk unavailable"));
    messenger.responseHandlers["history/delete"] = deleteSpy;
    messenger.responses["history/list"] = [
      {
        sessionId: "before",
        title: "Before",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
      {
        sessionId: "delete-me",
        title: "Delete me",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
      {
        sessionId: "after",
        title: "After",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [
      { panelId: "active-panel", sessionId: "delete-me", title: "Delete me" },
    ];

    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });

    fireEvent.click(await screen.findByLabelText("Delete Delete me"));

    expect(screen.queryByTitle("Delete me")).toBeNull();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not delete session",
    );
    expect(
      screen.getAllByTitle(/Before|After|Delete me/).map((node) => node.title),
    ).toEqual(["Before", "After", "Delete me"]);
    expect(
      screen.getByRole("button", { name: "Плагин 1" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });
});

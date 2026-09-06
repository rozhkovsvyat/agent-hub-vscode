import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import CukiiSessionNavigator, {
  formatSessionAge,
} from "./CukiiSessionNavigator";
import type { CukiiOpenChatPanel } from "core/protocol/ideWebview";
import type { SessionGroupState } from "./sessionGroups";

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

  it("asks for every session, not the newest hundred", async () => {
    // 🔴 `history/list` answers with the 100 most recent sessions unless a
    // limit says otherwise. Left at the default, the 101st chat simply stops
    // appearing in the navigator — not deleted, not archived, just gone from
    // the list with nothing on screen to explain it. The query reads metadata
    // only, so asking for all of them costs no session bodies.
    const messenger = new MockIdeMessenger();
    const listSpy = vi.fn(async (_options: { limit?: number }) => []);
    messenger.responseHandlers["history/list"] = listSpy;
    messenger.responses["cukii/listOpenChatPanels"] = [];

    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });

    expect(listSpy).toHaveBeenCalledWith({ limit: 1_000_000 });
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
    let persistedTitle = "A";
    const renameSpy = vi.fn(async ({ title }: { title: string }) => {
      persistedTitle = title;
      return { ok: true, title };
    });
    messenger.responseHandlers["cukii/renameSession"] = renameSpy;
    messenger.responseHandlers["history/list"] = vi.fn(async () => [
      {
        sessionId: "session",
        title: persistedTitle,
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ]);
    messenger.responseHandlers["cukii/listOpenChatPanels"] = vi.fn(async () => [
      { panelId: "panel", sessionId: "session", title: persistedTitle },
    ]);
    const openSpy = vi.fn().mockResolvedValue(undefined);
    messenger.responseHandlers["cukii/openChatPanel"] = openSpy;
    const firstRender = await renderWithProviders(<CukiiSessionNavigator />, {
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
    fireEvent.click(screen.getByTitle("D"));
    expect(openSpy).toHaveBeenCalledWith({
      panelId: "panel",
      sessionId: "session",
      title: "D",
    });

    firstRender.unmount();
    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });
    expect(await screen.findByTitle("D")).toBeInTheDocument();
  });

  it("submits a rapid Enter plus blur only once and keeps stale polling from undoing it", async () => {
    const messenger = new MockIdeMessenger();
    const renameSpy = vi.fn().mockResolvedValue({
      ok: true,
      title: "B",
      revision: 2,
    });
    messenger.responseHandlers["cukii/renameSession"] = renameSpy;
    messenger.responses["history/list"] = [
      {
        sessionId: "session",
        title: "A",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
        revision: 1,
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [
      { panelId: "panel", sessionId: "session", title: "A" },
    ];
    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });

    fireEvent.click(await screen.findByLabelText("Rename A"));
    const input = await screen.findByLabelText("Rename A");
    fireEvent.change(input, { target: { value: "B" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(await screen.findByTitle("B")).toBeInTheDocument();
    expect(renameSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            messageType: "cukii/openChatPanelsChanged",
            messageId: "stale-poll",
            data: [{ panelId: "panel", sessionId: "session", title: "A" }],
          },
        }),
      );
    });
    expect(await screen.findByTitle("B")).toBeInTheDocument();
    expect(screen.queryByTitle("A")).toBeNull();
  });

  it("rejects stale concurrent title broadcasts and accepts the next revision", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responses["history/list"] = [
      {
        sessionId: "session",
        title: "B",
        dateCreated: "2026-08-27T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
        revision: 2,
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [];
    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });
    expect(await screen.findByTitle("B")).toBeInTheDocument();

    const broadcast = async (title: string, revision: number) => {
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              messageType: "cukii/sessionTitleChanged",
              messageId: `title-${revision}`,
              data: { sessionId: "session", title, revision },
            },
          }),
        );
      });
    };
    await broadcast("stale A", 1);
    expect(screen.getByTitle("B")).toBeInTheDocument();
    await broadcast("C", 3);
    expect(await screen.findByTitle("C")).toBeInTheDocument();
    await broadcast("late B", 2);
    expect(screen.getByTitle("C")).toBeInTheDocument();
  });

  it("updates the sidebar row and reopen payload from the authoritative title broadcast", async () => {
    const messenger = new MockIdeMessenger();
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
    const openSpy = vi.fn().mockResolvedValue(undefined);
    messenger.responseHandlers["cukii/openChatPanel"] = openSpy;
    await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            messageType: "cukii/sessionTitleChanged",
            messageId: "title-broadcast",
            data: { sessionId: "session", title: "B" },
          },
        }),
      );
    });

    const renamed = await screen.findByTitle("B");
    fireEvent.click(renamed);
    expect(openSpy).toHaveBeenCalledWith({
      panelId: "panel",
      sessionId: "session",
      title: "B",
    });
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

describe("CukiiSessionNavigator Claude filter parity", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // Four sessions covering every cell of Claude's Status x Tabs matrix:
  //   needs-input/open, working/open, done/open (attention "ready"),
  //   archived-ish closed session with no panel at all.
  const SESSIONS = [
    {
      sessionId: "waiting",
      title: "Waiting session",
      dateCreated: "2026-08-27T12:00:00Z",
      workspaceDirectory: "D:/Brain/vault",
    },
    {
      sessionId: "running",
      title: "Running session",
      dateCreated: "2026-08-27T12:00:00Z",
      workspaceDirectory: "D:/Brain/vault",
    },
    {
      sessionId: "done",
      title: "Done session",
      dateCreated: "2026-08-27T12:00:00Z",
      workspaceDirectory: "D:/Brain/vault",
    },
    {
      sessionId: "closed",
      title: "Closed session",
      dateCreated: "2026-08-27T12:00:00Z",
      workspaceDirectory: "D:/Brain/vault",
    },
  ];
  // Typed against the wire contract on purpose: an attention value the host
  // cannot actually send must fail here, not silently widen to string.
  const PANELS: CukiiOpenChatPanel[] = [
    {
      panelId: "p-waiting",
      sessionId: "waiting",
      title: "Waiting session",
      attention: "pending-permission",
    },
    {
      panelId: "p-running",
      sessionId: "running",
      title: "Running session",
      attention: "streaming",
    },
    {
      panelId: "p-done",
      sessionId: "done",
      title: "Done session",
      attention: "none",
    },
  ];

  const mountNavigator = async (settledTitle = "Waiting session") => {
    const messenger = new MockIdeMessenger();
    messenger.responses["history/list"] = SESSIONS;
    messenger.responses["cukii/listOpenChatPanels"] = PANELS;
    const rendered = await renderWithProviders(<CukiiSessionNavigator />, {
      mockIdeMessenger: messenger,
    });
    await screen.findByTitle(settledTitle);
    return rendered;
  };

  const rowTitles = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(".cukii-session-button"),
    ).map((node) => node.title);

  const openFilterMenu = () => {
    fireEvent.click(screen.getByRole("button", { name: /^Filter by status/ }));
    return screen.getByRole("menu", { name: "Filter by status" });
  };

  it("shows the lightning Active chip counting needs-input plus working", async () => {
    const { container } = await mountNavigator();

    const chip = screen.getByRole("button", { name: "Active · 2" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(chip).toHaveAttribute(
      "title",
      "Show only sessions that need input or are working",
    );
    // Claude's own bolt glyph (heroicons 16/solid BoltIcon), not a text emoji.
    expect(chip.querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 16 16",
    );
    expect(container.textContent).toContain("Active · 2");
  });

  it("filters to needs-input plus working when the Active chip is pressed", async () => {
    await mountNavigator();
    expect(rowTitles()).toHaveLength(4);

    const chip = screen.getByRole("button", { name: "Active · 2" });
    fireEvent.click(chip);
    expect(rowTitles()).toEqual(["Waiting session", "Running session"]);
    expect(screen.getByRole("button", { name: "Active · 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Clicking the pressed chip clears it again.
    fireEvent.click(screen.getByRole("button", { name: "Active · 2" }));
    expect(rowTitles()).toHaveLength(4);
  });

  it("uses Claude's exact status and tabs menu, labels, counts and order", async () => {
    await mountNavigator();
    const menu = openFilterMenu();

    expect(
      Array.from(menu.querySelectorAll('[role="menuitemcheckbox"]')).map(
        (item) => item.textContent,
      ),
    ).toEqual([
      "Needs input · 1",
      "Working · 1",
      "Completed · 2",
      "Open · 3",
      "Closed · 1",
    ]);
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(
      Array.from(menu.querySelectorAll('[role="presentation"]')).map(
        (item) => item.textContent,
      ),
    ).toEqual(["Status", "Tabs"]);
    for (const item of menu.querySelectorAll('[role="menuitemcheckbox"]')) {
      expect(item).toHaveAttribute("aria-checked", "false");
    }
  });

  it("cuts the list down to each picked status and stays open across picks", async () => {
    await mountNavigator();
    openFilterMenu();

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: /Needs input/ }),
    );
    expect(rowTitles()).toEqual(["Waiting session"]);
    // keepOpen: the menu survives a pick so a second one needs no re-open.
    expect(
      screen.getByRole("menuitemcheckbox", { name: /Needs input/ }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("button", { name: "Filter by status, 1 selected" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Working/ }));
    expect(rowTitles()).toEqual(["Waiting session", "Running session"]);

    // Toggling a picked status off restores it.
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: /Needs input/ }),
    );
    expect(rowTitles()).toEqual(["Running session"]);

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: /^Completed/ }),
    );
    expect(rowTitles()).toEqual([
      "Running session",
      "Done session",
      "Closed session",
    ]);
  });

  it("cuts the list to Open and to Closed tabs independently of status", async () => {
    await mountNavigator();
    openFilterMenu();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Open/ }));
    expect(rowTitles()).toEqual([
      "Waiting session",
      "Running session",
      "Done session",
    ]);

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Closed/ }));
    // Both picked means "no constraint", exactly as Claude's empty-set rule.
    expect(rowTitles()).toHaveLength(4);

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Open/ }));
    expect(rowTitles()).toEqual(["Closed session"]);
    expect(
      screen.getByRole("button", { name: "Filter by status, 1 selected" }),
    ).toBeInTheDocument();
  });

  it("intersects status and tabs picks instead of unioning them", async () => {
    await mountNavigator();
    openFilterMenu();

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: /^Completed/ }),
    );
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Open/ }));
    expect(rowTitles()).toEqual(["Done session"]);
    expect(
      screen.getByRole("button", { name: "Filter by status, 2 selected" }),
    ).toBeInTheDocument();
  });

  /** The field lives behind the magnifier, exactly as in Claude's sidebar. */
  const openSearch = () =>
    fireEvent.click(screen.getByRole("button", { name: "Search sessions" }));
  /* 🔴 By role, not by label: the toggle and the field carry the SAME
     "Search sessions" label — as they do in Claude — so a label query matches
     whichever exists and can never tell the collapsed state from the open one. */
  const searchField = () =>
    screen.queryByRole("textbox", { name: "Search sessions" });
  const searchToggle = () =>
    screen.queryByRole("button", { name: "Search sessions" });

  it("keeps the search behind a magnifier and gives it back on Escape", async () => {
    // 🔴 1:1 with the live Claude sidebar (measured on 2.1.263): closed there is
    // no field at all, only a 24×24 button sitting next to "New group"; opening
    // it puts the field on its own line and takes the button away; Escape and
    // the clear button both close it AND drop the query, so the list is never
    // left filtered by a field nobody can see.
    await mountNavigator();
    expect(searchField()).toBeNull();
    expect(searchToggle()).toBeInTheDocument();

    openSearch();
    const field = searchField()!;
    expect(field).toBeInTheDocument();
    // Opening takes the button away, so the two never share the row.
    expect(searchToggle()).toBeNull();

    fireEvent.change(field, { target: { value: "running" } });
    expect(rowTitles()).toEqual(["Running session"]);

    fireEvent.keyDown(field, { key: "Escape" });
    expect(searchField()).toBeNull();
    expect(searchToggle()).toBeInTheDocument();
    expect(rowTitles()).toHaveLength(4);
  });

  it("NEGATIVE CONTROL: the clear button closes the search and unfilters the list", async () => {
    // Measured on the live sidebar: "Clear search" does not merely empty the
    // field, it collapses it — and it is the only way back to the magnifier
    // without the keyboard. A clear that left the field open would leave the
    // list still narrowed on the next render.
    await mountNavigator();
    openSearch();
    fireEvent.change(screen.getByLabelText("Search sessions"), {
      target: { value: "running" },
    });
    expect(rowTitles()).toEqual(["Running session"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(searchField()).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    expect(searchToggle()).toBeInTheDocument();
    expect(rowTitles()).toHaveLength(4);
  });

  it("stacks the filters on top of the substring search", async () => {
    await mountNavigator();
    openFilterMenu();
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: /^Completed/ }),
    );
    expect(rowTitles()).toEqual(["Done session", "Closed session"]);

    openSearch();
    fireEvent.change(screen.getByLabelText("Search sessions"), {
      target: { value: "closed" },
    });
    expect(rowTitles()).toEqual(["Closed session"]);

    // The search alone would keep "Closed session"; the status alone would
    // keep both. Only the conjunction produces this pair of results.
    fireEvent.change(screen.getByLabelText("Search sessions"), {
      target: { value: "session" },
    });
    expect(rowTitles()).toEqual(["Done session", "Closed session"]);
  });

  it("keeps counts on the unfiltered list so a chip never reports its own result", async () => {
    await mountNavigator();
    fireEvent.click(screen.getByRole("button", { name: "Active · 2" }));
    expect(rowTitles()).toHaveLength(2);
    // Two rows visible, but the counts still describe all four sessions.
    expect(
      screen.getByRole("button", { name: "Active · 2" }),
    ).toBeInTheDocument();
    openFilterMenu();
    expect(
      Array.from(
        screen
          .getByRole("menu", { name: "Filter by status" })
          .querySelectorAll('[role="menuitemcheckbox"]'),
      ).map((item) => item.textContent),
    ).toEqual([
      "Needs input · 1",
      "Working · 1",
      "Completed · 2",
      "Open · 3",
      "Closed · 1",
    ]);
  });

  it("opens and closes the filter menu on real pointer clicks of the funnel", async () => {
    // fireEvent.click skips mousedown; a real click fires it first, so the
    // outside-click guard and the button's own toggle must not fight.
    const { user } = await mountNavigator();
    const funnel = screen.getByRole("button", { name: "Filter by status" });
    expect(funnel).toHaveAttribute("aria-expanded", "false");

    await user.click(funnel);
    expect(
      screen.getByRole("menu", { name: "Filter by status" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("menuitemcheckbox", { name: /^Open/ }));
    // keepOpen: picking an entry leaves the menu up.
    expect(
      screen.getByRole("menu", { name: "Filter by status" }),
    ).toBeInTheDocument();
    expect(rowTitles()).toEqual([
      "Waiting session",
      "Running session",
      "Done session",
    ]);

    await user.click(
      screen.getByRole("button", { name: "Filter by status, 1 selected" }),
    );
    expect(
      screen.queryByRole("menu", { name: "Filter by status" }),
    ).not.toBeInTheDocument();
    // Closing the menu keeps the pick; only the entry itself clears it.
    expect(rowTitles()).toHaveLength(3);
  });

  it("says so instead of going blank when a filter cuts everything", async () => {
    await mountNavigator();
    openFilterMenu();
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: /Needs input/ }),
    );
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Closed/ }));

    expect(rowTitles()).toEqual([]);
    expect(screen.getByTestId("cukii-session-empty-state")).toHaveTextContent(
      "No sessions found",
    );
  });

  it("starts every mount unfiltered and writes no filter state anywhere", async () => {
    // Claude keeps this in component state alone (`[c,P0]=useState(Ih)`).
    // Persisting it produced the failure this test exists to prevent: an
    // "Active" chip left on filtered the whole list out after a restart, and
    // the sidebar read as broken rather than as filtered.
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const first = await mountNavigator();
    fireEvent.click(screen.getByRole("button", { name: "Active · 2" }));
    openFilterMenu();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Working/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /^Open/ }));
    expect(rowTitles()).toEqual(["Running session"]);
    expect(
      setItem.mock.calls.filter(([key]) => String(key).includes("filter")),
    ).toEqual([]);

    first.unmount();
    await mountNavigator();
    expect(rowTitles()).toEqual([
      "Waiting session",
      "Running session",
      "Done session",
      "Closed session",
    ]);
    expect(screen.getByRole("button", { name: "Active · 2" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Filter by status" }),
    ).toBeInTheDocument();
    setItem.mockRestore();
  });

  it("keeps the row being renamed on screen even when a filter excludes it", async () => {
    // Claude's `if(q1.sessionId.value===B0)return!0` ahead of the filter pass:
    // committing a rename must not make the input vanish under the caret.
    await mountNavigator();
    fireEvent.click(
      screen.getByRole("button", { name: "Rename Done session" }),
    );
    const input = screen.getByLabelText("Rename Done session");

    // "Done session" is completed, so the Active chip excludes it — but it is
    // the row under edit, so it has to stay.
    fireEvent.click(screen.getByRole("button", { name: "Active · 2" }));
    expect(input).toBeInTheDocument();
    expect(rowTitles()).toEqual(["Waiting session", "Running session"]);

    // Ending the rename hands the row back to the filter that excludes it.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Rename Done session")).toBeNull();
    expect(rowTitles()).toEqual(["Waiting session", "Running session"]);
  });

  it("clears search and filters when a group is created", async () => {
    // Claude's create-group path ends in `O1(""),n5(!1),P0(Ih)` — the group you
    // just made has to be visible, not hidden behind the narrowing that was on.
    await mountNavigator();
    openSearch();
    fireEvent.change(screen.getByLabelText("Search sessions"), {
      target: { value: "running" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Active · 2" }));
    expect(rowTitles()).toEqual(["Running session"]);

    fireEvent.click(screen.getByRole("button", { name: /New group/ }));
    fireEvent.change(await screen.findByLabelText("Group name"), {
      target: { value: "Плагин" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    // The field collapses with its query: left open and empty it would sit
    // where the magnifier belongs, a field the user never opened.
    expect(searchField()).toBeNull();
    expect(searchToggle()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active · 2" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(rowTitles()).toHaveLength(4);
  });

  // Negative control. Nothing here asserts an incidental detail: every
  // expectation below is false the moment the status predicate stops
  // discriminating (returns true for everything, or ignores its input).
  it("NEGATIVE CONTROL: a predicate that stops discriminating breaks this", async () => {
    await mountNavigator();
    const all = [
      "Waiting session",
      "Running session",
      "Done session",
      "Closed session",
    ];
    expect(rowTitles()).toEqual(all);

    openFilterMenu();
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: /Needs input/ }),
    );
    // A predicate stuck on "true" would leave all four here.
    expect(rowTitles()).toEqual(["Waiting session"]);
    expect(rowTitles()).not.toEqual(all);

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: /Needs input/ }),
    );
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: /^Completed/ }),
    );
    // A predicate stuck on "false" would leave none here, and one that
    // ignores the picked set would not move the result between the two picks.
    expect(rowTitles()).toEqual(["Done session", "Closed session"]);
    expect(rowTitles()).not.toEqual(all);
    expect(rowTitles()).not.toEqual([]);
  });
});

describe("CukiiSessionNavigator cross-window group sync", () => {
  it("retries loading groups until core answers and never saves before that", async () => {
    // Remote-SSH windows start with an empty per-window cache; the mount
    // attempt can race core boot and must be retried by the poll.
    localStorage.removeItem("cukii.session-groups.v1");
    const messenger = new MockIdeMessenger();
    messenger.responses["history/list"] = [
      {
        sessionId: "ssh-session",
        title: "SSH session",
        dateCreated: "2026-08-31T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [];
    const saveSpy = vi.fn().mockResolvedValue({ ok: true });
    messenger.responseHandlers["cukii/sessionGroupsSave"] = saveSpy;
    let coreReady = false;
    messenger.responseHandlers["cukii/sessionGroupsLoad"] = vi.fn(async () => {
      if (!coreReady) {
        throw new Error("core is still booting");
      }
      return {
        groups: [{ id: "work", name: "Работа" }],
        assignments: { "ssh-session": "work" },
      };
    });

    vi.useFakeTimers();
    try {
      await renderWithProviders(<CukiiSessionNavigator />, {
        mockIdeMessenger: messenger,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByRole("button", { name: "Работа 1" })).toBeNull();
      // No synced copy yet: an empty cache must not overwrite the shared one.
      expect(saveSpy).not.toHaveBeenCalled();

      coreReady = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(
        screen.getByRole("button", { name: "Работа 1" }),
      ).toBeInTheDocument();
      expect(screen.getByTitle("SSH session")).toBeInTheDocument();
      // Loading the shared copy must not echo-save it back.
      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("converges with group edits made in another window within one poll", async () => {
    localStorage.removeItem("cukii.session-groups.v1");
    const messenger = new MockIdeMessenger();
    messenger.responses["history/list"] = [
      {
        sessionId: "ssh-session",
        title: "SSH session",
        dateCreated: "2026-08-31T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [];
    const saveSpy = vi.fn().mockResolvedValue({ ok: true });
    messenger.responseHandlers["cukii/sessionGroupsSave"] = saveSpy;
    let core: SessionGroupState = {
      groups: [{ id: "work", name: "Работа" }],
      assignments: { "ssh-session": "work" },
    };
    messenger.responseHandlers["cukii/sessionGroupsLoad"] = vi.fn(
      async () => core,
    );

    vi.useFakeTimers();
    try {
      await renderWithProviders(<CukiiSessionNavigator />, {
        mockIdeMessenger: messenger,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        screen.getByRole("button", { name: "Работа 1" }),
      ).toBeInTheDocument();

      // Another window on the same host renames the group; the shared
      // journal-side copy is the only notification channel.
      core = {
        groups: [{ id: "work", name: "Проекты" }],
        assignments: { "ssh-session": "work" },
      };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(
        screen.getByRole("button", { name: "Проекты 1" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Работа 1" })).toBeNull();
      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a local edit while its save is in flight against a stale poll", async () => {
    localStorage.setItem(
      "cukii.session-groups.v1",
      JSON.stringify({
        groups: [{ id: "plugin", name: "Плагин" }],
        assignments: { session: "plugin" },
      }),
    );
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
    let core: SessionGroupState = {
      groups: [{ id: "plugin", name: "Плагин" }],
      assignments: { session: "plugin" },
    };
    messenger.responseHandlers["cukii/sessionGroupsLoad"] = vi.fn(
      async () => core,
    );
    let resolveSave: ((value: { ok: boolean }) => void) | undefined;
    const saveSpy = vi.fn(
      (payload) =>
        new Promise<{ ok: boolean }>((resolve) => {
          resolveSave = (value) => {
            core = payload;
            resolve(value);
          };
        }),
    );
    messenger.responseHandlers["cukii/sessionGroupsSave"] = saveSpy;

    vi.useFakeTimers();
    try {
      await renderWithProviders(<CukiiSessionNavigator />, {
        mockIdeMessenger: messenger,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const header = screen.getByRole("button", { name: "Плагин 1" });

      fireEvent.contextMenu(header, { clientX: 120, clientY: 160 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename group" }));
      const input = screen.getByLabelText("Rename group Плагин");
      fireEvent.change(input, { target: { value: "Проекты" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(
        screen.getByRole("button", { name: "Проекты 1" }),
      ).toBeInTheDocument();
      expect(saveSpy).toHaveBeenCalledTimes(1);

      // The next poll still reads the pre-edit copy; it must not revert the
      // edit whose save has not landed yet.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(
        screen.getByRole("button", { name: "Проекты 1" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Плагин 1" })).toBeNull();

      resolveSave?.({ ok: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(core.groups).toEqual([{ id: "plugin", name: "Проекты" }]);
      expect(saveSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies an empty snapshot when another window deleted every group", async () => {
    localStorage.setItem(
      "cukii.session-groups.v1",
      JSON.stringify({
        groups: [{ id: "work", name: "Работа" }],
        assignments: { "ssh-session": "work" },
      }),
    );
    const messenger = new MockIdeMessenger();
    messenger.responses["history/list"] = [
      {
        sessionId: "ssh-session",
        title: "SSH session",
        dateCreated: "2026-08-31T12:00:00Z",
        workspaceDirectory: "D:/Brain/vault",
      },
    ];
    messenger.responses["cukii/listOpenChatPanels"] = [];
    let core: SessionGroupState = {
      groups: [{ id: "work", name: "Работа" }],
      assignments: { "ssh-session": "work" },
    };
    messenger.responseHandlers["cukii/sessionGroupsLoad"] = vi.fn(
      async () => core,
    );
    messenger.responseHandlers["cukii/sessionGroupsSave"] = vi
      .fn()
      .mockResolvedValue({ ok: true });

    vi.useFakeTimers();
    try {
      const first = await renderWithProviders(<CukiiSessionNavigator />, {
        mockIdeMessenger: messenger,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        screen.getByRole("button", { name: "Работа 1" }),
      ).toBeInTheDocument();

      // Another window deletes the last group: the empty snapshot is a
      // real state, not a migration trigger.
      core = { groups: [], assignments: {} };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.queryByRole("button", { name: "Работа 1" })).toBeNull();
      expect(screen.getByTitle("SSH session")).toBeInTheDocument();

      // A remount must not resurrect the deleted groups from the cache.
      first.unmount();
      await renderWithProviders(<CukiiSessionNavigator />, {
        mockIdeMessenger: messenger,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByRole("button", { name: "Работа 1" })).toBeNull();
      expect(screen.getByTitle("SSH session")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes rapid edits so only the newest payload lands", async () => {
    localStorage.setItem(
      "cukii.session-groups.v1",
      JSON.stringify({
        groups: [{ id: "plugin", name: "Плагин" }],
        assignments: {},
      }),
    );
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
    let core: SessionGroupState = {
      groups: [{ id: "plugin", name: "Плагин" }],
      assignments: {},
    };
    messenger.responseHandlers["cukii/sessionGroupsLoad"] = vi.fn(
      async () => core,
    );
    const saveCalls: SessionGroupState[] = [];
    const resolvers: Array<(value: { ok: boolean }) => void> = [];
    const saveSpy = vi.fn((payload: SessionGroupState) => {
      saveCalls.push(payload);
      return new Promise<{ ok: boolean }>((resolve) => {
        resolvers.push((value) => {
          core = payload;
          resolve(value);
        });
      });
    });
    messenger.responseHandlers["cukii/sessionGroupsSave"] = saveSpy;

    const renameGroup = (fromName: string, toName: string) => {
      fireEvent.contextMenu(
        screen.getByRole("button", { name: `${fromName} 0` }),
        { clientX: 120, clientY: 160 },
      );
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename group" }));
      const input = screen.getByLabelText(`Rename group ${fromName}`);
      fireEvent.change(input, { target: { value: toName } });
      fireEvent.keyDown(input, { key: "Enter" });
    };

    vi.useFakeTimers();
    try {
      await renderWithProviders(<CukiiSessionNavigator />, {
        mockIdeMessenger: messenger,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      renameGroup("Плагин", "Проекты");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(saveSpy).toHaveBeenCalledTimes(1);

      // Second edit while the first save is still in flight: it must be
      // queued, not fired as a racing second request.
      renameGroup("Проекты", "Релизы");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(saveSpy).toHaveBeenCalledTimes(1);

      resolvers[0]?.({ ok: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(saveSpy).toHaveBeenCalledTimes(2);
      resolvers[1]?.({ ok: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(saveCalls.map((state) => state.groups[0]?.name)).toEqual([
        "Проекты",
        "Релизы",
      ]);
      expect(core.groups).toEqual([{ id: "plugin", name: "Релизы" }]);
      expect(
        screen.getByRole("button", { name: "Релизы 0" }),
      ).toBeInTheDocument();

      // The following poll reads back the acked copy and must not re-save.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(saveSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

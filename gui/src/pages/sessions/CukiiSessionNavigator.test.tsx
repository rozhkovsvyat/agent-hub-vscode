import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
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
    expect(screen.getByText('Move to "Плагин"')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("menu", {
        name: "Session actions for привет - продолжим?",
      }),
    ).not.toBeInTheDocument();
  });
});

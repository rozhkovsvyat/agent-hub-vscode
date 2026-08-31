import { describe, expect, it } from "vitest";

import {
  CukiiPanelRegistry,
  CUKII_BLANK_PANEL_TITLE,
  getCukiiRenameTarget,
  isPersistableCukiiTitle,
  listCukiiRenameTargets,
  listOpenCukiiPanels,
  syncCukiiPanelTitleForSession,
} from "./cukiiPanelRegistry";

describe("CukiiPanelRegistry", () => {
  it("keeps unlimited blank panels independent", () => {
    const registry = new CukiiPanelRegistry<{ panel: { title: string } }>();
    registry.add("one", { panel: { title: CUKII_BLANK_PANEL_TITLE } });
    registry.add("two", { panel: { title: CUKII_BLANK_PANEL_TITLE } });
    registry.add("three", { panel: { title: CUKII_BLANK_PANEL_TITLE } });

    expect(registry.size).toBe(3);
    expect(registry.lastActive()?.id).toBe("three");
    expect(listOpenCukiiPanels(registry)).toEqual([]);
  });

  it("focuses a persisted session without collapsing other panels", () => {
    const registry = new CukiiPanelRegistry<object>();
    registry.add("one", {}, "session-a");
    registry.add("two", {}, "session-b");

    expect(registry.forSession("session-a")?.id).toBe("one");
    expect(registry.size).toBe(2);
  });

  it("updates and releases session indexes with panel lifecycle", () => {
    const registry = new CukiiPanelRegistry<object>();
    registry.add("one", {});
    registry.updateSession("one", "created-session");
    expect(registry.forSession("created-session")?.id).toBe("one");

    registry.remove("one");
    expect(registry.forSession("created-session")).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it("lists only persisted sessions, including reserved manual titles", () => {
    const registry = new CukiiPanelRegistry<{ panel: { title: string } }>();
    registry.add("blank", { panel: { title: CUKII_BLANK_PANEL_TITLE } });
    registry.add(
      "saved",
      { panel: { title: CUKII_BLANK_PANEL_TITLE } },
      "session-1",
    );
    registry.updateTitle("saved", "Ship sidebar parity");

    expect(listOpenCukiiPanels(registry)).toEqual([
      {
        panelId: "saved",
        sessionId: "session-1",
        title: "Ship sidebar parity",
      },
    ]);
  });

  it("treats non-empty titles as valid manual titles; blankness is session identity", () => {
    expect(isPersistableCukiiTitle(CUKII_BLANK_PANEL_TITLE)).toBe(true);
    expect(isPersistableCukiiTitle("New Session")).toBe(true);
    expect(isPersistableCukiiTitle("  Fix tests  ")).toBe(true);
    expect(isPersistableCukiiTitle("   ")).toBe(false);
  });

  it("keeps exact reserved manual titles in the sidebar", () => {
    const registry = new CukiiPanelRegistry<{ panel: { title: string } }>();
    registry.add(
      "cukii-title",
      { panel: { title: CUKII_BLANK_PANEL_TITLE } },
      "s1",
    );
    registry.updateTitle("cukii-title", CUKII_BLANK_PANEL_TITLE);
    registry.add("new-title", { panel: { title: "New Session" } }, "s2");
    registry.updateTitle("new-title", "New Session");

    expect(listOpenCukiiPanels(registry)).toEqual([
      { panelId: "cukii-title", sessionId: "s1", title: "Cukii" },
      { panelId: "new-title", sessionId: "s2", title: "New Session" },
    ]);
  });

  it("propagates repeated renamed titles to the matching panel host", () => {
    const registry = new CukiiPanelRegistry<{ panel: { title: string } }>();
    registry.add("saved", { panel: { title: "Old title" } }, "session-1");
    registry.updateTitle("saved", "Old title");

    syncCukiiPanelTitleForSession("session-1", "Manual title A", registry);
    syncCukiiPanelTitleForSession("session-1", "Manual title B", registry);

    const entry = registry.forSession("session-1");
    expect(entry?.displayTitle).toBe("Manual title B");
    expect(entry?.panel.panel.title).toBe("Manual title B");
    expect(listOpenCukiiPanels(registry)[0]?.title).toBe("Manual title B");
  });

  it("keeps native-rename targets panel-specific and excludes blank tabs", () => {
    const registry = new CukiiPanelRegistry<{ panel: { title: string } }>();
    registry.add("blank", { panel: { title: CUKII_BLANK_PANEL_TITLE } });
    registry.add("first", { panel: { title: "First" } }, "session-1");
    registry.add("second", { panel: { title: "Second" } }, "session-2");
    registry.updateTitle("first", "First");
    registry.updateTitle("second", "Second");

    expect(listCukiiRenameTargets(registry)).toEqual([
      { panelId: "first", sessionId: "session-1", title: "First" },
      { panelId: "second", sessionId: "session-2", title: "Second" },
    ]);

    // The native menu's QuickPick returns this id; a different last-active
    // panel must not redirect the rename.
    registry.markActive("first");
    expect(getCukiiRenameTarget("second", registry)?.id).toBe("second");
    expect(getCukiiRenameTarget("blank", registry)).toBeUndefined();
  });
});

import type { BaseSessionMetadata } from "core";
import { describe, expect, it } from "vitest";
import { groupSessions, parseSessionGroups } from "./sessionGroups";
import { formatSessionAge } from "./CukiiSessionNavigator";
import { mergeSessionsWithOpenPanels } from "./cukiiSessionMerge";

const sessions: BaseSessionMetadata[] = [
  {
    sessionId: "one",
    title: "Claude task",
    dateCreated: "2026-08-27T12:00:00Z",
    workspaceDirectory: "D:/Brain/vault",
  },
  {
    sessionId: "two",
    title: "Codex review",
    dateCreated: "2026-08-27T13:00:00Z",
    workspaceDirectory: "D:/Brain/vault",
  },
];

describe("Cukii session groups", () => {
  it("keeps ungrouped sessions visible and assigns grouped sessions", () => {
    const grouped = groupSessions(sessions, {
      groups: [{ id: "release", name: "Release" }],
      assignments: { two: "release" },
    });

    expect(grouped[0].sessions.map((session) => session.sessionId)).toEqual([
      "one",
    ]);
    expect(grouped[1].sessions.map((session) => session.sessionId)).toEqual([
      "two",
    ]);
  });

  it("recovers from malformed persisted group state", () => {
    expect(parseSessionGroups("not-json")).toEqual({
      groups: [],
      assignments: {},
    });
  });

  it("never renders NaN for malformed session dates", () => {
    expect(formatSessionAge("not-a-date")).toBe("");
    expect(formatSessionAge(new Date().toISOString())).toMatch(/^\d+m$/u);
  });
});

describe("Cukii session sidebar lifecycle", () => {
  it("shows zero sidebar rows for ten blank open panels", () => {
    const blankPanels = Array.from({ length: 10 }, (_, index) => ({
      panelId: `panel-${index}`,
      title: "Cukii",
    }));

    expect(mergeSessionsWithOpenPanels([], blankPanels)).toEqual([]);
    expect(mergeSessionsWithOpenPanels(sessions, blankPanels)).toEqual(
      sessions.map((session) => ({ ...session, openPanelId: undefined })),
    );
  });

  it("merges persisted sessions with their open panel ids only once", () => {
    const merged = mergeSessionsWithOpenPanels(sessions, [
      { panelId: "panel-one", sessionId: "one", title: "Claude task" },
      { panelId: "panel-blank", title: "Cukii" },
      { panelId: "panel-one-dup", sessionId: "one", title: "Claude task" },
    ]);

    expect(merged.map((session) => session.sessionId)).toEqual(["one", "two"]);
    expect(
      merged.find((session) => session.sessionId === "one")?.openPanelId,
    ).toBe("panel-one");
    expect(
      merged.find((session) => session.sessionId === "two")?.openPanelId,
    ).toBeUndefined();
  });

  it("ignores open panel titles that include model names", () => {
    const merged = mergeSessionsWithOpenPanels(
      [
        {
          sessionId: "saved",
          title: "Fix flaky test",
          dateCreated: "2026-08-27T12:00:00Z",
          workspaceDirectory: "D:/Brain/vault",
        },
      ],
      [
        {
          panelId: "panel-saved",
          sessionId: "saved",
          title: "Opus 5 · Fix flaky test",
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("Fix flaky test");
    expect(merged[0]?.openPanelId).toBe("panel-saved");
  });
});

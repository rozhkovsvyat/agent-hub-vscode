import type { BaseSessionMetadata } from "core";
import { describe, expect, it } from "vitest";
import { groupSessions, parseSessionGroups } from "./sessionGroups";
import { mergeSessionsWithOpenPanels } from "./CukiiSessionNavigator";

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

  it("merges open blank panels with persisted and closed sessions", () => {
    const merged = mergeSessionsWithOpenPanels(sessions, [
      { panelId: "panel-one", sessionId: "one", title: "Claude task" },
      { panelId: "panel-blank", title: "New session" },
    ]);

    expect(merged.map((session) => session.sessionId)).toEqual([
      "open:panel-blank",
      "one",
      "two",
    ]);
    expect(
      merged.find((session) => session.sessionId === "one")?.openPanelId,
    ).toBe("panel-one");
    expect(
      merged.find((session) => session.sessionId === "two")?.openPanelId,
    ).toBeUndefined();
  });
});

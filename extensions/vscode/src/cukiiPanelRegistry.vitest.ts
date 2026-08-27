import { describe, expect, it } from "vitest";

import { CukiiPanelRegistry } from "./cukiiPanelRegistry";

describe("CukiiPanelRegistry", () => {
  it("keeps unlimited blank panels independent", () => {
    const registry = new CukiiPanelRegistry<object>();
    registry.add("one", {});
    registry.add("two", {});
    registry.add("three", {});

    expect(registry.size).toBe(3);
    expect(registry.lastActive()?.id).toBe("three");
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
});

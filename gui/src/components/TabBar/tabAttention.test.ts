import { describe, expect, it } from "vitest";
import { deriveTabAttention, snapshotLeavingAttention } from "./tabAttention";

describe("deriveTabAttention", () => {
  it("prefers a pending permission over streaming", () => {
    expect(deriveTabAttention({ isStreaming: true, pendingCount: 1 })).toBe(
      "pending-permission",
    );
  });

  it("marks an in-flight turn as streaming", () => {
    expect(deriveTabAttention({ isStreaming: true, pendingCount: 0 })).toBe(
      "streaming",
    );
  });

  it("is idle when nothing is happening", () => {
    expect(deriveTabAttention({ isStreaming: false, pendingCount: 0 })).toBe(
      "none",
    );
  });
});

describe("snapshotLeavingAttention", () => {
  it("keeps live pending/streaming on the tab you leave", () => {
    expect(snapshotLeavingAttention("none", "pending-permission")).toBe(
      "pending-permission",
    );
    expect(snapshotLeavingAttention("none", "streaming")).toBe("streaming");
  });

  it("turns a leftover live state into ready once the turn ended", () => {
    expect(snapshotLeavingAttention("streaming", "none")).toBe("ready");
    expect(snapshotLeavingAttention("pending-permission", "none")).toBe(
      "ready",
    );
  });

  it("keeps ready until the tab is focused again", () => {
    expect(snapshotLeavingAttention("ready", "none")).toBe("ready");
  });
});

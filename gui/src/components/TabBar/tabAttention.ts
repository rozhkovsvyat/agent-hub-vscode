import type { TabAttention } from "../../redux/slices/tabsSlice";

export function deriveTabAttention(opts: {
  isStreaming: boolean;
  pendingCount: number;
}): TabAttention {
  if (opts.pendingCount > 0) {
    return "pending-permission";
  }
  if (opts.isStreaming) {
    return "streaming";
  }
  return "none";
}

/** Snapshot the tab being left. Live activity sticks; a just-finished stream becomes ready. */
export function snapshotLeavingAttention(
  stored: TabAttention | undefined,
  live: TabAttention,
): TabAttention {
  if (live !== "none") {
    return live;
  }
  if (stored === "streaming" || stored === "pending-permission") {
    return "ready";
  }
  return stored === "ready" ? "ready" : "none";
}

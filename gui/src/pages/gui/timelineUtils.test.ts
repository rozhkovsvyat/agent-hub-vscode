import { ChatHistoryItem } from "core";
import { describe, expect, it } from "vitest";
import { getActiveTimelineToolId, getToolTimelineClass } from "./timelineUtils";

describe("getToolTimelineClass", () => {
  it("maps Claude-style rail colors from tool status", () => {
    expect(getToolTimelineClass("done")).toBe("cukii-timeline-checkpoint");
    expect(getToolTimelineClass("errored")).toBe("cukii-timeline-failed");
    expect(getToolTimelineClass("canceled")).toBe("cukii-timeline-failed");
    expect(getToolTimelineClass("generated")).toBe("cukii-timeline-warning");
    expect(getToolTimelineClass("calling")).toBe("cukii-timeline-current");
    expect(getToolTimelineClass("generating")).toBe("cukii-timeline-current");
  });

  it("atomically selects the last in-progress tool from stable transcript order", () => {
    const history = [
      {
        message: { id: "assistant", role: "assistant", content: "" },
        contextItems: [],
        toolCallStates: [
          { toolCallId: "first", toolCall: { id: "first", type: "function", function: { name: "read", arguments: "{}" } }, status: "calling" },
          { toolCallId: "second", toolCall: { id: "second", type: "function", function: { name: "bash", arguments: "{}" } }, status: "calling" },
        ],
      },
    ] as ChatHistoryItem[];
    expect(getActiveTimelineToolId(history)).toBe("second");
    history[0].toolCallStates![1].status = "done";
    expect(getActiveTimelineToolId(history)).toBe("first");
    history[0].toolCallStates![0].status = "done";
    expect(getActiveTimelineToolId(history)).toBeUndefined();
    expect(getToolTimelineClass("calling", false)).toBe("cukii-timeline-event");
    expect(getToolTimelineClass("done", true)).not.toBe("cukii-timeline-current");
  });
});

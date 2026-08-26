import { describe, expect, it } from "vitest";
import { getToolTimelineClass } from "./timelineUtils";

describe("getToolTimelineClass", () => {
  it("maps Claude-style rail colors from tool status", () => {
    expect(getToolTimelineClass("done")).toBe("cukii-timeline-checkpoint");
    expect(getToolTimelineClass("errored")).toBe("cukii-timeline-failed");
    expect(getToolTimelineClass("canceled")).toBe("cukii-timeline-failed");
    expect(getToolTimelineClass("generated")).toBe("cukii-timeline-warning");
    expect(getToolTimelineClass("calling")).toBe("cukii-timeline-current");
    expect(getToolTimelineClass("generating")).toBe("cukii-timeline-current");
  });
});

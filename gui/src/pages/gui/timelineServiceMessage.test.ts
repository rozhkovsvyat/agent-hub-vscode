import { describe, expect, it } from "vitest";
import { isTimelineServiceMessage } from "./timelineServiceMessage";

describe("isTimelineServiceMessage", () => {
  it("recognizes background-agent completion as a timeline event (ID-218)", () => {
    expect(
      isTimelineServiceMessage(
        'Background agent "general-purpose: Review PostToolUse dispatch candidate" completed.',
      ),
    ).toBe(true);
    expect(
      isTimelineServiceMessage("Subagent planner finished."),
    ).toBe(true);
  });

  it("leaves ordinary assistant answers as chat bubbles", () => {
    expect(
      isTimelineServiceMessage(
        "Background agent work is done, here is the review.",
      ),
    ).toBe(false);
    expect(isTimelineServiceMessage("Принято: только штатный tombstone.")).toBe(
      false,
    );
  });
});

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
          {
            toolCallId: "first",
            toolCall: {
              id: "first",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
            status: "calling",
          },
          {
            toolCallId: "second",
            toolCall: {
              id: "second",
              type: "function",
              function: { name: "bash", arguments: "{}" },
            },
            status: "calling",
          },
        ],
      },
    ] as unknown as ChatHistoryItem[];
    expect(getActiveTimelineToolId(history)).toBe("second");
    history[0].toolCallStates![1].status = "done";
    expect(getActiveTimelineToolId(history)).toBe("first");
    history[0].toolCallStates![0].status = "done";
    expect(getActiveTimelineToolId(history)).toBeUndefined();
    expect(getToolTimelineClass("calling", false)).toBe("cukii-timeline-event");
    expect(getToolTimelineClass("done", true)).not.toBe(
      "cukii-timeline-current",
    );
  });

  it("keeps exactly one terminal current row across start/start/out-of-order complete races", () => {
    const history = [
      {
        message: { role: "assistant", content: "" },
        contextItems: [],
        toolCallStates: [
          {
            toolCallId: "powershell-1",
            toolCall: {
              id: "powershell-1",
              type: "function",
              function: { name: "bash", arguments: "{}" },
            },
            status: "calling",
          },
          {
            toolCallId: "powershell-2",
            toolCall: {
              id: "powershell-2",
              type: "function",
              function: { name: "bash", arguments: "{}" },
            },
            status: "calling",
          },
        ],
      },
    ] as unknown as ChatHistoryItem[];

    const activeRows = () => {
      const activeId = getActiveTimelineToolId(history);
      const tools = history[0].toolCallStates!.map((tool) =>
        getToolTimelineClass(tool.status, tool.toolCallId === activeId),
      );
      return [...tools, activeId ? "loader-idle" : "cukii-timeline-current"];
    };

    expect(getActiveTimelineToolId(history)).toBe("powershell-2");
    expect(
      activeRows().filter((row) => row === "cukii-timeline-current"),
    ).toHaveLength(1);

    history[0].toolCallStates![1].status = "done";
    expect(getActiveTimelineToolId(history)).toBe("powershell-1");
    expect(activeRows().at(-1)).toBe("loader-idle");
    expect(
      activeRows().filter((row) => row === "cukii-timeline-current"),
    ).toHaveLength(1);

    history[0].toolCallStates!.push({
      toolCallId: "loader-tool",
      toolCall: {
        id: "loader-tool",
        type: "function",
        function: { name: "read", arguments: "{}" },
      },
      parsedArgs: {},
      status: "generating",
    });
    expect(getActiveTimelineToolId(history)).toBe("loader-tool");
    history[0].toolCallStates![2].status = "done";
    expect(getActiveTimelineToolId(history)).toBe("powershell-1");
    expect(activeRows().at(-1)).toBe("loader-idle");
  });
});

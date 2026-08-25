import { ToolCallState } from "core";
import { describe, expect, it } from "vitest";
import {
  getCursorBridgeProgress,
  isCursorBridgeToolCall,
} from "./CursorBridgeProgress";

function cursorStatus(payload: Record<string, unknown>): ToolCallState {
  return {
    toolCallId: "cursor-job",
    status: "done",
    toolCall: {
      id: "cursor-job",
      type: "function",
      function: {
        name: "cursor-bridge__cursor_status",
        arguments: "{}",
      },
    },
    output: [
      {
        name: "Tool output",
        description: "Cursor bridge status",
        content: JSON.stringify(payload),
      },
    ],
  } as ToolCallState;
}

function brokerDelegate(payload: Record<string, unknown>): ToolCallState {
  return {
    toolCallId: "broker-job",
    status: "done",
    toolCall: {
      id: "broker-job",
      type: "function",
      function: {
        name: "mcp__cukii-broker__broker_delegate",
        arguments: "{}",
      },
    },
    output: [
      {
        name: "Tool output",
        description: "Broker delegate",
        content: JSON.stringify(payload),
      },
    ],
  } as ToolCallState;
}

describe("CursorBridgeProgress", () => {
  it("shows a live subagent instead of collapsing its status into output lines", () => {
    const status = cursorStatus({
      active: true,
      model: "composer-2.5",
      progress: {
        phase: "working",
        elapsed_seconds: 42,
        event_count: 3,
        latest_activity: "tool_call: read_file",
        changed_files: [" M gui/src/pages/gui/Chat.tsx"],
      },
    });

    expect(isCursorBridgeToolCall(status)).toBe(true);
    expect(getCursorBridgeProgress(status)).toEqual({
      active: true,
      model: "composer-2.5",
      phase: "working",
      elapsedSeconds: 42,
      eventCount: 3,
      latestActivity: "tool_call: read_file",
      changedFiles: [" M gui/src/pages/gui/Chat.tsx"],
    });
  });

  it("treats broker_delegate as a live nested worker, not a mute tool card", () => {
    const status = brokerDelegate({
      task_id: "t1",
      scope: "hub",
      worker_status: "running",
      model: "Composer 2.5",
    });

    expect(isCursorBridgeToolCall(status)).toBe(true);
    expect(getCursorBridgeProgress(status)).toMatchObject({
      active: true,
      model: "Composer 2.5",
      phase: "running",
      latestActivity: "running",
    });
  });
});

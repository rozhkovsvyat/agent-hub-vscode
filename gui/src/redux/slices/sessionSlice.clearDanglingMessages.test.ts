import { describe, expect, it } from "vitest";
import { TOOL_INTERRUPTED_MESSAGE } from "core/tools/constants";
import {
  ChatHistoryItemWithMessageId,
  clearDanglingMessages,
  sessionSlice,
} from "./sessionSlice";

function userItem(): ChatHistoryItemWithMessageId {
  return {
    message: { role: "user", content: "run it", id: "u1" },
    contextItems: [],
  };
}

function assistantWithTool(
  status: "generating" | "calling" | "generated" | "done",
): ChatHistoryItemWithMessageId {
  return {
    message: {
      role: "assistant",
      content: "working",
      id: "a1",
    },
    contextItems: [],
    toolCallStates: [
      {
        status,
        toolCallId: "t1",
        toolCall: {
          id: "t1",
          type: "function",
          function: { name: "Read", arguments: "{}" },
        },
        parsedArgs: { file_path: "a.ts" },
      },
    ],
  };
}

describe("sessionSlice clearDanglingMessages", () => {
  it("cancels calling tools and writes Tool interrupted", () => {
    const initial = sessionSlice.getInitialState();
    const withHistory = {
      ...initial,
      history: [userItem(), assistantWithTool("calling")],
      isStreaming: true,
    };

    const next = sessionSlice.reducer(withHistory, clearDanglingMessages());
    const tool = next.history[1].toolCallStates?.[0];

    expect(tool?.status).toBe("canceled");
    expect(tool?.output?.[0]?.content).toBe(TOOL_INTERRUPTED_MESSAGE);
    expect(next.history[1].interrupted).toBe(false);
  });

  it("paints Interrupted only for an explicit user turn cancellation", () => {
    const initial = sessionSlice.getInitialState();
    const withHistory = {
      ...initial,
      history: [userItem(), assistantWithTool("done")],
      isStreaming: true,
    };

    const lifecycle = sessionSlice.reducer(
      withHistory,
      clearDanglingMessages(),
    );
    const userStop = sessionSlice.reducer(
      withHistory,
      clearDanglingMessages("turn"),
    );

    expect(lifecycle.history.filter((item) => item.interrupted)).toHaveLength(
      0,
    );
    expect(userStop.history.filter((item) => item.interrupted)).toHaveLength(1);
  });

  it("cancels generating tools the same way", () => {
    const initial = sessionSlice.getInitialState();
    const withHistory = {
      ...initial,
      history: [userItem(), assistantWithTool("generating")],
      isStreaming: true,
    };

    const next = sessionSlice.reducer(withHistory, clearDanglingMessages());
    const tool = next.history[1].toolCallStates?.[0];

    expect(tool?.status).toBe("canceled");
    expect(tool?.output?.[0]?.name).toBe(TOOL_INTERRUPTED_MESSAGE);
  });

  it("does not rewrite output of already completed tools", () => {
    const initial = sessionSlice.getInitialState();
    const done = assistantWithTool("done");
    done.toolCallStates![0].output = [
      { name: "Read", description: "ok", content: "file body" },
    ];
    const withHistory = {
      ...initial,
      history: [userItem(), done],
    };

    const next = sessionSlice.reducer(withHistory, clearDanglingMessages());
    const tool = next.history[1].toolCallStates?.[0];

    expect(tool?.status).toBe("done");
    expect(tool?.output?.[0]?.content).toBe("file body");
  });
});

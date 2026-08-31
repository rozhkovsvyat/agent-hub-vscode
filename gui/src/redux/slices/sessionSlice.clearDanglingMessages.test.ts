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

function queuedSteer(id: string): ChatHistoryItemWithMessageId {
  return {
    message: { role: "user", content: id, id },
    contextItems: [],
    isSteer: true,
    steerStatus: "queued",
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
    expect(next.history[1].interrupted).toBeFalsy();
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
    const lateLifecycle = sessionSlice.reducer(
      userStop,
      clearDanglingMessages(),
    );
    expect(
      lateLifecycle.history.filter((item) => item.interrupted),
    ).toHaveLength(1);
  });

  it.each([undefined, "turn", "tool"] as const)(
    "preserves queued/deferred steer outbox during %s cleanup",
    (interrupted) => {
      const initial = sessionSlice.getInitialState();
      const deferred = queuedSteer("deferred");
      deferred.steerStatus = "deferred";
      const queued = queuedSteer("queued");
      const withHistory = {
        ...initial,
        history: [
          userItem(),
          {
            message: {
              role: "assistant" as const,
              content: "working",
              id: "a1",
            },
            contextItems: [],
          },
          deferred,
          queued,
        ],
        isStreaming: true,
      };

      const next = sessionSlice.reducer(
        withHistory,
        clearDanglingMessages(interrupted),
      );

      expect(
        next.history
          .filter((item) => item.isSteer)
          .map((item) => [item.message.id, item.steerStatus]),
      ).toEqual([
        ["deferred", "deferred"],
        ["queued", "queued"],
      ]);
    },
  );

  it("keeps turn Interrupted when a late tool receipt has no GUI tool card", () => {
    const initial = sessionSlice.getInitialState();
    const withHistory = {
      ...initial,
      history: [
        userItem(),
        {
          message: { role: "assistant" as const, content: "working", id: "a1" },
          contextItems: [],
        },
      ],
    };

    const stopped = sessionSlice.reducer(
      withHistory,
      clearDanglingMessages("turn"),
    );
    const lateToolReceipt = sessionSlice.reducer(
      stopped,
      clearDanglingMessages("tool"),
    );

    expect(
      lateToolReceipt.history.filter((item) => item.interrupted),
    ).toHaveLength(1);
  });

  it("uses exactly one tool marker when a real GUI tool card exists", () => {
    const initial = sessionSlice.getInitialState();
    const withHistory = {
      ...initial,
      history: [userItem(), assistantWithTool("calling")],
    };

    const next = sessionSlice.reducer(
      withHistory,
      clearDanglingMessages("tool"),
    );

    expect(next.history.filter((item) => item.interrupted)).toHaveLength(0);
    expect(
      next.history[1].toolCallStates?.filter(
        (tool) => tool.output?.[0]?.content === TOOL_INTERRUPTED_MESSAGE,
      ),
    ).toHaveLength(1);
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

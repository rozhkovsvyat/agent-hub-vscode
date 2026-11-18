import { describe, expect, it } from "vitest";
import {
  clearDanglingMessages,
  newSession,
  sessionSlice,
} from "./sessionSlice";

const reduce = sessionSlice.reducer;

describe("Interrupted marker after a Stop (card 27b3f1a6)", () => {
  it("lands on the assistant answer and survives a late tool receipt when the tool already finished", () => {
    let state = reduce(
      undefined,
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: [
          {
            message: { id: "u", role: "user", content: "run sleep" },
            contextItems: [],
          },
          {
            message: {
              id: "a",
              role: "assistant",
              content: "Starting it in the background",
            },
            contextItems: [],
            toolCallStates: [
              {
                toolCallId: "t1",
                status: "done",
                toolCall: {
                  id: "t1",
                  type: "function",
                  function: { name: "Shell", arguments: "{}" },
                },
              } as any,
            ],
          },
          {
            message: {
              id: "th",
              role: "thinking",
              content: "Crumbing through it..",
            },
            contextItems: [],
          },
        ] as any,
      }),
    );
    state = reduce(state, clearDanglingMessages("turn"));
    const answer = () => state.history.find((item) => item.message.id === "a")!;
    expect(answer().interrupted).toBe(true);
    state = reduce(state, clearDanglingMessages("tool"));
    expect(answer().interrupted).toBe(true);
  });
});

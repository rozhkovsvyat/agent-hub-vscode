import type { Session } from "../index.js";
import { describe, expect, it } from "vitest";

import { compactSessionForPersistence } from "./historyCompaction.js";

function session(history: Session["history"]): Session {
  return {
    sessionId: "session-1",
    title: "Long broker session",
    workspaceDirectory: "D:/repo",
    history,
  };
}

describe("compactSessionForPersistence", () => {
  it("drops only a terminal tool transport row reconstructed from assistant state", () => {
    const original = session([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        contextItems: [],
        toolCallStates: [
          {
            toolCallId: "call-1",
            toolCall: {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
            status: "done",
            parsedArgs: {},
            output: [{ name: "file", description: "", content: "payload" }],
          },
        ],
      },
      {
        message: { role: "tool", content: "payload", toolCallId: "call-1" },
        contextItems: [
          {
            id: { providerTitle: "test", itemId: "1" },
            name: "file",
            description: "",
            content: "payload",
          },
        ],
      },
      { message: { role: "assistant", content: "Done" }, contextItems: [] },
    ]);

    const compacted = compactSessionForPersistence(original);

    expect(compacted.history.map((item) => item.message.role)).toEqual([
      "assistant",
      "assistant",
    ]);
    expect(compacted.history[0].toolCallStates?.[0].output?.[0].content).toBe(
      "payload",
    );
    expect(original.history).toHaveLength(3);
  });

  it("preserves unmatched and non-terminal tool rows", () => {
    const original = session([
      {
        message: { role: "assistant", content: "" },
        contextItems: [],
        toolCallStates: [
          {
            toolCallId: "call-running",
            toolCall: {
              id: "call-running",
              type: "function",
              function: { name: "shell", arguments: "{}" },
            },
            status: "calling",
            parsedArgs: {},
          },
        ],
      },
      {
        message: {
          role: "tool",
          content: "partial",
          toolCallId: "call-running",
        },
        contextItems: [],
      },
      {
        message: { role: "tool", content: "future", toolCallId: "unknown" },
        contextItems: [],
      },
    ]);

    expect(compactSessionForPersistence(original)).toBe(original);
  });
});

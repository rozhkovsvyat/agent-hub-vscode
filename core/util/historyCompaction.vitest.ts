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

  it("preserves the only result when a terminal state has no matching output", () => {
    const original = session([
      {
        message: { role: "assistant", content: "" },
        contextItems: [],
        toolCallStates: [
          {
            toolCallId: "item_0",
            toolCall: {
              id: "item_0",
              type: "function",
              function: { name: "shell", arguments: "{}" },
            },
            status: "done",
            parsedArgs: {},
          },
        ],
      },
      {
        message: {
          role: "tool",
          content: "ONLY_COPY",
          toolCallId: "item_0",
        },
        contextItems: [],
      },
    ]);

    expect(compactSessionForPersistence(original)).toBe(original);
  });

  it("does not let an old terminal id delete a newer running result", () => {
    const original = session([
      {
        message: { role: "assistant", content: "" },
        contextItems: [],
        toolCallStates: [
          {
            toolCallId: "item_0",
            toolCall: {
              id: "item_0",
              type: "function",
              function: { name: "old", arguments: "{}" },
            },
            status: "done",
            parsedArgs: {},
            // IDs and payload bytes can both repeat across vendor turns. The
            // newer calling state must still supersede this old evidence.
            output: [
              {
                name: "old",
                description: "",
                content: "NEW_PARTIAL_ONLY_COPY",
              },
            ],
          },
        ],
      },
      {
        message: { role: "assistant", content: "" },
        contextItems: [],
        toolCallStates: [
          {
            toolCallId: "item_0",
            toolCall: {
              id: "item_0",
              type: "function",
              function: { name: "new", arguments: "{}" },
            },
            status: "calling",
            parsedArgs: {},
          },
        ],
      },
      {
        message: {
          role: "tool",
          content: "NEW_PARTIAL_ONLY_COPY",
          toolCallId: "item_0",
        },
        contextItems: [],
      },
    ]);

    expect(compactSessionForPersistence(original)).toBe(original);
  });

  it("preserves a terminal row when its payload differs from stored output", () => {
    const original = session([
      {
        message: { role: "assistant", content: "" },
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
            output: [{ name: "file", description: "", content: "OLD" }],
          },
        ],
      },
      {
        message: {
          role: "tool",
          content: "NEW",
          toolCallId: "call-1",
        },
        contextItems: [],
      },
    ]);

    expect(compactSessionForPersistence(original)).toBe(original);
  });
});

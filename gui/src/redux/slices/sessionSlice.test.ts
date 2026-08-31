import { ChatMessage } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { v4 as uuidv4 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addToolCallDeltaToState } from "../../util/toolCallState";
import {
  ChatHistoryItemWithMessageId,
  appendUserSteerMessage,
  markSteerRead,
  newSession,
  sessionSlice,
  setActive,
  setBridgeWait,
  setBrokerModel,
  switchBrokerModel,
  setBrokerPermissionMode,
  setInactive,
  markLatestUserReceiptDelivered,
  setSteerStatus,
  abortStream,
  streamUpdate,
  submitEditorAndInitAtIndex,
} from "./sessionSlice";

// Mock dependencies
vi.mock("uuid");
vi.mock("core/util/messageContent");
vi.mock("../../util/toolCallState");

const mockUuidv4 = vi.mocked(uuidv4);
const mockRenderChatMessage = vi.mocked(renderChatMessage);
const mockAddToolCallDeltaToState = vi.mocked(addToolCallDeltaToState);

describe("sessionSlice streamUpdate", () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();

    // Mock uuidv4 to return predictable values
    let callCount = 0;
    mockUuidv4.mockImplementation(() => `mock-uuid-${++callCount}`);

    // Mock renderChatMessage to return content as is
    mockRenderChatMessage.mockImplementation((message: ChatMessage) => {
      if (typeof message.content === "string") {
        return message.content;
      }
      return "";
    });

    // Mock addToolCallDeltaToState
    mockAddToolCallDeltaToState.mockImplementation((delta, state) => {
      return {
        status: "generating" as const,
        toolCall: {
          id: delta.id || "mock-tool-id",
          type: "function" as const,
          function: {
            name: delta.function?.name || "mock-function",
            arguments: delta.function?.arguments || "{}",
          },
        },
        toolCallId: delta.id || "mock-tool-id",
        parsedArgs: {},
      };
    });
  });

  const createInitialState = () => ({
    lastSessionId: undefined,
    isSessionLoading: false,
    allSessionMetadata: [],
    history: [
      {
        message: {
          role: "user" as const,
          content: "This is a test.",
          id: "initial-user-message",
        },
        contextItems: [],
      },
    ] as ChatHistoryItemWithMessageId[],
    isStreaming: false,
    title: "Test Session",
    titleManuallySet: false,
    revision: 0,
    id: "test-session-id",
    streamAborter: new AbortController(),
    symbols: {},
    mode: "chat" as const,
    brokerEffort: "high" as const,
    brokerSpeed: "standard" as const,
    brokerPermissionMode: "manual" as const,
    hasReasoningEnabled: true,
    isInEdit: false,
    codeBlockApplyStates: {
      states: [],
      curIndex: 0,
    },
    newestToolbarPreviewForInput: {},
    isSessionMetadataLoading: false,
    compactionLoading: {},
    pendingClaudePermissions: {},
  });

  it("restores controls per session and resets new tabs to defaults", () => {
    const restored = sessionSlice.reducer(
      undefined,
      newSession({
        sessionId: "effort-speed-session",
        title: "Independent controls",
        workspaceDirectory: "D:/Brain/vault",
        history: [],
        brokerModel: "codex-5-6-terra",
        brokerSubagent: "auto",
        brokerEffort: "medium",
        brokerSpeed: "fast",
        brokerPermissionMode: "auto",
        hasReasoningEnabled: false,
      }),
    );
    expect(restored.brokerEffort).toBe("medium");
    expect(restored.brokerSpeed).toBe("fast");
    expect(restored.brokerPermissionMode).toBe("auto");
    expect(restored.hasReasoningEnabled).toBe(false);
    expect(restored.titleManuallySet).toBe(false);

    const blank = sessionSlice.reducer(restored, newSession(undefined));
    expect(blank.brokerEffort).toBe("high");
    expect(blank.brokerSpeed).toBe("standard");
    expect(blank.brokerPermissionMode).toBe("bypass");
    expect(blank.hasReasoningEnabled).toBe(true);
  });

  it("keeps a pending mode on a model switch until the live probe reconciles it", () => {
    const initial = sessionSlice.getInitialState();
    const withEditAutomatically = sessionSlice.reducer(
      initial,
      setBrokerPermissionMode("editAutomatically"),
    );
    const codex = sessionSlice.reducer(
      withEditAutomatically,
      setBrokerModel("codex-5-6-terra"),
    );

    // Reducers have no native CLI facts. The bridge rejects this combination
    // until PermissionModeControl receives a real capability response.
    expect(codex.brokerPermissionMode).toBe("editAutomatically");
  });

  it("records only real model transitions in order, including rapid cross-vendor switches", () => {
    const initial = sessionSlice.getInitialState();
    const terra = sessionSlice.reducer(
      initial,
      switchBrokerModel({
        model: "codex-5-6-terra",
        displayName: "GPT-5.6 Terra",
      }),
    );
    const sameModel = sessionSlice.reducer(
      terra,
      switchBrokerModel({
        model: "codex-5-6-terra",
        displayName: "GPT-5.6 Terra",
      }),
    );
    const grok = sessionSlice.reducer(
      sameModel,
      switchBrokerModel({ model: "grok-4-6", displayName: "Grok 4.6" }),
    );
    const nextTurn = sessionSlice.reducer(
      grok,
      submitEditorAndInitAtIndex({
        index: grok.history.length,
        editorState: { type: "doc" },
      }),
    );

    expect(grok.history.map((item) => item.modelSwitch?.displayName)).toEqual([
      "GPT-5.6 Terra",
      "Grok 4.6",
    ]);
    expect(grok.history.map((item) => item.message.role)).toEqual([
      "system",
      "system",
    ]);
    expect(nextTurn.history.map((item) => item.message.role)).toEqual([
      "system",
      "system",
      "user",
      "assistant",
    ]);
  });

  it("reconciles an unsupported permission preference before a Kimi turn, but preserves a supported one", () => {
    const manualClaude = sessionSlice.reducer(
      sessionSlice.getInitialState(),
      setBrokerPermissionMode("manual"),
    );
    const kimi = sessionSlice.reducer(
      manualClaude,
      switchBrokerModel({ model: "kimi-k3", displayName: "Kimi K3" }),
    );

    expect(kimi.brokerModel).toBe("kimi-k3");
    expect(kimi.brokerPermissionMode).toBe("bypass");
    // The session serializer reads these exact reducer fields, so its next
    // save persists the reconciled route instead of stale Manual.
    expect(kimi).toMatchObject({
      brokerModel: "kimi-k3",
      brokerPermissionMode: "bypass",
    });

    const claudePlan = sessionSlice.reducer(
      sessionSlice.getInitialState(),
      setBrokerPermissionMode("plan"),
    );
    const sonnet = sessionSlice.reducer(
      claudePlan,
      switchBrokerModel({ model: "sonnet-5", displayName: "Sonnet 5" }),
    );
    expect(sonnet.brokerPermissionMode).toBe("plan");
  });

  it("restores stale Kimi Manual as its verified prompt-mode bypass route", () => {
    const restoredKimi = sessionSlice.reducer(
      undefined,
      newSession({
        sessionId: "restored-kimi-manual",
        title: "Restored Kimi session",
        workspaceDirectory: "D:/Brain/vault",
        history: [],
        brokerModel: "kimi-k3",
        brokerSubagent: "auto",
        brokerEffort: "high",
        brokerSpeed: "standard",
        brokerPermissionMode: "manual",
        hasReasoningEnabled: true,
      }),
    );

    expect(restoredKimi).toMatchObject({
      brokerModel: "kimi-k3",
      brokerPermissionMode: "bypass",
    });

    const restoredCodex = sessionSlice.reducer(
      undefined,
      newSession({
        sessionId: "restored-codex-manual",
        title: "Restored Codex session",
        workspaceDirectory: "D:/Brain/vault",
        history: [],
        brokerModel: "codex-5-6-terra",
        brokerSubagent: "auto",
        brokerEffort: "high",
        brokerSpeed: "standard",
        brokerPermissionMode: "manual",
        hasReasoningEnabled: true,
      }),
    );
    expect(restoredCodex.brokerPermissionMode).toBe("manual");
  });

  it("restores a manual title and clears its lock for a fresh tab", () => {
    const restored = sessionSlice.reducer(
      undefined,
      newSession({
        sessionId: "manually-renamed-session",
        title: "Windows lifecycle investigation",
        titleManuallySet: true,
        workspaceDirectory: "D:/Brain/vault",
        history: [],
      }),
    );

    expect(restored.title).toBe("Windows lifecycle investigation");
    expect(restored.titleManuallySet).toBe(true);

    const blank = sessionSlice.reducer(restored, newSession(undefined));
    expect(blank.titleManuallySet).toBe(false);
  });

  describe("Basic Chat Message", () => {
    it("should append assistant message to history", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "Here is a response to your message without thinking.",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe(
        "Here is a response to your message without thinking.",
      );
      expect(newState.history[1].message.id).toBe("mock-uuid-1");
      expect(newState.history[1].contextItems).toEqual([]);
    });
  });

  describe("Chat Message With Thinking", () => {
    it("should split thinking and assistant content correctly", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content:
              "<think>I should send the user a response.</think> Here is a response to your message with thinking.",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);

      // Check reasoning
      expect(newState.history[0].reasoning?.text).toBe(
        "I should send the user a response.",
      );

      // Check assistant message
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe(
        "Here is a response to your message with thinking.",
      );
      expect(newState.history[1].message.id).toBe("mock-uuid-1");
    });
  });

  describe("Tool Call With Response", () => {
    it("should handle tool call followed by tool response and assistant message", () => {
      const initialState = createInitialState();
      const toolCallAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "<think>I should use a tool call.</think>",
            toolCalls: [
              {
                id: "1234",
                type: "function" as const,
                function: {
                  name: "builtin_ls",
                  arguments: '{"dirPath":".","recursive":false}',
                },
              },
            ],
          },
        ],
      };

      let newState = sessionSlice.reducer(initialState, toolCallAction);
      expect(newState.history).toHaveLength(2);

      // Check reasoning
      expect(newState.history[0].reasoning?.text).toBe(
        "I should use a tool call.",
      );

      // Check generating message
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe("");
      expect(newState.history[1].toolCallStates?.[0]?.status).toBe(
        "generating",
      );
      expect(newState.history[1].toolCallStates?.[0]?.toolCallId).toBe("1234");

      const toolResponseAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "tool" as const,
            toolCallId: "1234",
            content: "foo.txt\nbar.txt\nexample.php",
          },
          {
            role: "assistant" as const,
            content: "I see, the tool found 3 files.",
          },
        ],
      };
      newState = sessionSlice.reducer(newState, toolResponseAction);
      expect(newState.history).toHaveLength(4);

      // Check tool message
      expect(newState.history[2].message.role).toBe("tool");
      expect(newState.history[2].message.content).toBe(
        "foo.txt\nbar.txt\nexample.php",
      );
      expect((newState.history[2].message as any).toolCallId).toBe("1234");

      // Check final assistant message
      expect(newState.history[3].message.role).toBe("assistant");
      expect(newState.history[3].message.content).toBe(
        "I see, the tool found 3 files.",
      );
    });
  });

  describe("Tool Call With Streaming Response", () => {
    it("should handle streaming assistant response after tool call", () => {
      const initialState = createInitialState();
      const toolCallAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "<think>I should use a tool call.</think>",
            toolCalls: [
              {
                id: "1234",
                type: "function" as const,
                function: {
                  name: "builtin_ls",
                  arguments: '{"dirPath":".","recursive":false}',
                },
              },
            ],
          },
        ],
      };

      let newState = sessionSlice.reducer(initialState, toolCallAction);
      expect(newState.history).toHaveLength(2);

      // Check reasoning
      expect(newState.history[0].reasoning?.text).toBe(
        "I should use a tool call.",
      );

      // Check generating message
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe("");
      expect(newState.history[1].toolCallStates?.[0]?.status).toBe(
        "generating",
      );
      expect(newState.history[1].toolCallStates?.[0]?.toolCallId).toBe("1234");

      const toolResponseAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "tool" as const,
            toolCallId: "1234",
            content: "foo.txt\nbar.txt\nexample.php",
          },
          {
            role: "assistant" as const,
            content: "<think>",
          },
          {
            role: "assistant" as const,
            content: "Good, ",
          },
          {
            role: "assistant" as const,
            content: "I received a list",
          },
          {
            role: "assistant" as const,
            content: " of files.",
          },
          {
            role: "assistant" as const,
            content: "</think>",
          },
          {
            role: "assistant" as const,
            content: "\n",
          },
          {
            role: "assistant" as const,
            content: "I see, ",
          },
          {
            role: "assistant" as const,
            content: "the tool ",
          },
          {
            role: "assistant" as const,
            content: "found 3 ",
          },
          {
            role: "assistant" as const,
            content: "files.",
          },
        ],
      };

      newState = sessionSlice.reducer(newState, toolResponseAction);

      expect(newState.history).toHaveLength(4);

      // Check tool message
      expect(newState.history[2].message.role).toBe("tool");
      expect(newState.history[2].message.content).toBe(
        "foo.txt\nbar.txt\nexample.php",
      );

      // Check response message
      expect(newState.history[3].message.role).toBe("assistant");
      expect(newState.history[3].message.content).toBe(
        "I see, the tool found 3 files.",
      );
      expect(newState.history[3].reasoning?.text).toBe(
        "Good, I received a list of files.",
      );
      expect(newState.history[3].reasoning?.active).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty history gracefully", () => {
      const initialState = createInitialState();
      initialState.history = [];

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "Hello",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      // Should not crash and history should remain empty
      expect(newState.history).toHaveLength(0);
    });

    it("should handle redacted thinking messages", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "thinking" as const,
            content: "This should be hidden",
            redactedThinking: true,
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.role).toBe("thinking");
      expect(newState.history[1].message.content).toBe(
        "internal reasoning is hidden due to safety reasons",
      );
      expect((newState.history[1].message as any).redactedThinking).toBe(true);
    });

    it("should handle signature updates for thinking messages", () => {
      const initialState = createInitialState();
      // First add a thinking message
      initialState.history.push({
        message: {
          role: "thinking",
          content: "Some thinking",
          id: "thinking-message",
        },
        contextItems: [],
      });

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "thinking" as const,
            signature: "test-signature",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect((newState.history[1].message as any).signature).toBe(
        "test-signature",
      );
    });

    it("should accumulate content for same role messages", () => {
      const initialState = createInitialState();
      // Add an assistant message first
      initialState.history.push({
        message: {
          role: "assistant",
          content: "Hello ",
          id: "assistant-message",
        },
        contextItems: [],
      });

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "world!",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.content).toBe("Hello world!");
    });

    it("should handle basic tool call streaming", () => {
      const initialState = createInitialState();
      const toolCallId = "call_123";

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "",
            toolCalls: [
              {
                id: toolCallId,
                type: "function" as const,
                function: {
                  name: "test_tool",
                  arguments: '{"arg":"value"}',
                },
              },
            ],
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].toolCallStates).toHaveLength(1);
    });
  });
});

describe("sessionSlice mid-task steer messages", () => {
  it("adds one-check receipt to a normal initial user turn before it can be read", () => {
    const submitted = sessionSlice.reducer(
      sessionSlice.getInitialState(),
      submitEditorAndInitAtIndex({ index: 0, editorState: { type: "doc" } }),
    );
    const delivered = sessionSlice.reducer(
      submitted,
      markLatestUserReceiptDelivered(),
    );
    expect(delivered.history[0].messageReceipt).toMatchObject({
      status: "delivered",
    });
    const read = sessionSlice.reducer(
      delivered,
      markSteerRead({ messageId: delivered.history[0].message.id }),
    );
    expect(read.history[0].messageReceipt?.status).toBe("read");
  });
  it("ignores steer while idle", () => {
    const next = sessionSlice.reducer(
      sessionSlice.getInitialState(),
      appendUserSteerMessage({ content: "too late", messageId: "late" }),
    );
    expect(next.history).toHaveLength(0);
  });

  it("appends every user follow-up to history while streaming", () => {
    const streaming = sessionSlice.reducer(
      sessionSlice.getInitialState(),
      setActive(),
    );
    const first = sessionSlice.reducer(
      streaming,
      appendUserSteerMessage({ content: "one", messageId: "one" }),
    );
    const second = sessionSlice.reducer(
      first,
      appendUserSteerMessage({ content: "two", messageId: "two" }),
    );
    expect(second.history.map((item) => item.message.content)).toEqual([
      "one",
      "two",
    ]);
    expect(second.history.every((item) => item.message.role === "user")).toBe(
      true,
    );
    expect(second.history.every((item) => item.isSteer)).toBe(true);
    expect(
      second.history.every((item) => Number.isFinite(item.steerSentAt)),
    ).toBe(true);
  });

  it("upgrades exactly an accepted follow-up from one check to two", () => {
    const streaming = sessionSlice.reducer(
      sessionSlice.getInitialState(),
      setActive(),
    );
    const queued = sessionSlice.reducer(
      streaming,
      appendUserSteerMessage({ content: "read me", messageId: "receipt-1" }),
    );
    const accepted = sessionSlice.reducer(
      queued,
      setSteerStatus({ messageId: "receipt-1", status: "delivered" }),
    );
    const read = sessionSlice.reducer(
      accepted,
      markSteerRead({ messageId: "receipt-1" }),
    );
    expect(read.history[0].steerStatus).toBe("read");

    const failed = sessionSlice.reducer(
      queued,
      setSteerStatus({ messageId: "receipt-1", status: "failed" }),
    );
    expect(
      sessionSlice.reducer(failed, markSteerRead({ messageId: "receipt-1" }))
        .history[0].steerStatus,
    ).toBe("failed");
  });

  it("restores persisted receipts and never invents legacy receipt data", () => {
    const history: ChatHistoryItemWithMessageId[] = [
      {
        message: { id: "saved", role: "user", content: "saved" },
        contextItems: [],
        isSteer: true,
        steerStatus: "read",
        steerSentAt: 1_700_000_000_000,
      },
      {
        message: { id: "legacy", role: "user", content: "legacy" },
        contextItems: [],
        isSteer: true,
      },
    ];
    const restored = sessionSlice.reducer(
      sessionSlice.getInitialState(),
      newSession({
        sessionId: "receipt-history",
        title: "Receipt history",
        workspaceDirectory: "D:/Scratch/cukii-release-2.0.67",
        history,
      }),
    );
    expect(restored.history[0]).toMatchObject({
      steerStatus: "read",
      steerSentAt: 1_700_000_000_000,
    });
    expect(restored.history[1]).toMatchObject({ steerStatus: "failed" });
    expect(restored.history[1].steerSentAt).toBeUndefined();
  });

  it("restores persisted model switches and safely ignores malformed legacy receipts", () => {
    const history: ChatHistoryItemWithMessageId[] = [
      {
        message: { id: "switch", role: "system", content: "" },
        contextItems: [],
        modelSwitch: {
          model: "codex-5-6-terra",
          displayName: "GPT-5.6 Terra",
        },
      },
      {
        message: { id: "legacy", role: "system", content: "" },
        contextItems: [],
        modelSwitch: { model: "", displayName: "" },
      },
    ];
    const restored = sessionSlice.reducer(
      sessionSlice.getInitialState(),
      newSession({
        sessionId: "model-switch-history",
        title: "Model switch history",
        workspaceDirectory: "D:/Scratch/cukii-release-2.0.67",
        history,
      }),
    );

    expect(restored.history[0].modelSwitch).toEqual({
      model: "codex-5-6-terra",
      displayName: "GPT-5.6 Terra",
    });
    expect(restored.history[1].modelSwitch).toBeUndefined();
  });

  it("brands a legacy Kimi model-switch receipt when restoring history", () => {
    const restored = sessionSlice.reducer(
      sessionSlice.getInitialState(),
      newSession({
        sessionId: "kimi-model-switch-history",
        title: "Kimi history",
        workspaceDirectory: "D:/Scratch/cukii-release-2.0.67",
        history: [
          {
            message: { id: "kimi-switch", role: "system", content: "" },
            contextItems: [],
            modelSwitch: { model: "kimi-k3", displayName: "K3" },
          },
        ],
      }),
    );

    expect(restored.history[0].modelSwitch).toEqual({
      model: "kimi-k3",
      displayName: "Kimi K3",
    });
  });

  it("newSession drops in-flight steer messages with the rest of history", () => {
    const streaming = sessionSlice.reducer(
      sessionSlice.getInitialState(),
      setActive(),
    );
    const steered = sessionSlice.reducer(
      streaming,
      appendUserSteerMessage({ content: "steer", messageId: "steer" }),
    );
    const next = sessionSlice.reducer(steered, newSession(undefined));
    expect(next.history).toHaveLength(0);
    expect(next.isStreaming).toBe(false);
  });
});

describe("sessionSlice native bridge wait state", () => {
  const receipt = {
    condition: "Sleeping for 12 seconds",
    deadline: "2026-08-31T12:00:12.000Z",
  };

  it("enters wait and clears it on the next factual activity", () => {
    const waiting = sessionSlice.reducer(
      sessionSlice.reducer(sessionSlice.getInitialState(), setActive()),
      setBridgeWait(receipt),
    );
    expect(waiting.bridgeWait).toEqual(receipt);

    const activeAgain = sessionSlice.reducer(
      waiting,
      streamUpdate([{ role: "thinking", content: "Working again" }]),
    );
    expect(activeAgain.bridgeWait).toBeUndefined();
  });

  it("never restores stale wait state after completion, interruption, or a new session", () => {
    const waiting = sessionSlice.reducer(
      sessionSlice.getInitialState(),
      setBridgeWait(receipt),
    );

    expect(
      sessionSlice.reducer(waiting, setInactive()).bridgeWait,
    ).toBeUndefined();
    expect(
      sessionSlice.reducer(waiting, abortStream()).bridgeWait,
    ).toBeUndefined();
    expect(
      sessionSlice.reducer(waiting, newSession(undefined)).bridgeWait,
    ).toBeUndefined();
  });
});

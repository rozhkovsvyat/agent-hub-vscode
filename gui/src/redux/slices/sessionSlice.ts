import {
  ActionReducerMapBuilder,
  AsyncThunk,
  PayloadAction,
  createSelector,
  createSlice,
} from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/react";
import {
  ApplyState,
  AssistantChatMessage,
  BaseSessionMetadata,
  ChatHistoryItem,
  ChatMessage,
  ContextItem,
  ContextItemWithId,
  FileSymbolMap,
  McpUiState,
  MessageModes,
  PromptLog,
  RuleMetadata,
  Session,
  ThinkingChatMessage,
  Tool,
  ToolCallDelta,
  ToolCallState,
} from "core";
import { mergeReasoningDetails } from "core/llm/openaiTypeConverters";
import { canonicalCukiiModelLabel } from "core/cukiiModelPresentation";
import { NEW_SESSION_TITLE } from "core/util/constants";
import {
  renderChatMessage,
  renderContextItems,
} from "core/util/messageContent";
import { TOOL_INTERRUPTED_MESSAGE } from "core/tools/constants";
import { findUriInDirs, getUriPathBasename } from "core/util/uri";
import type {
  BrokerEffort,
  BrokerModel,
  BrokerSpeed,
  BrokerSubagent,
  CukiiPermissionMode,
  CukiiClaudePermissionRequest,
} from "core/protocol/ideWebview";
import { findLastIndex } from "lodash";
import { v4 as uuidv4 } from "uuid";
import {
  brokerVendorForModel,
  coerceStoredPermissionMode,
  defaultVendorPermissionCapabilities,
  resolvePermissionModeForVendor,
} from "core/cukiiPermissionModes";
import { type InlineErrorMessageType } from "../../components/mainInput/InlineErrorMessage";
import { toolCallCtxItemToCtxItemWithId } from "../../pages/gui/ToolCallDiv/utils";
import { addToolCallDeltaToState, isEditTool } from "../../util/toolCallState";
import { RootState } from "../store";
import { streamResponseThunk } from "../thunks/streamResponse";
import { findChatHistoryItemByToolCallId, findToolCallById } from "../util";

/**
 * Helper function to filter out duplicate edit/search-replace tool calls.
 * Only keeps the first occurrence of edit tools.
 *
 * We don't support multiple parallel apply calls - see tool definitions for
 * instructions we provide to models to prevent this behavior.
 */
function filterMultipleEditToolCalls(
  toolCalls: ToolCallDelta[],
): ToolCallDelta[] {
  let hasSeenEditTool = false;

  return toolCalls.filter((toolCall) => {
    if (toolCall.function?.name && isEditTool(toolCall.function?.name)) {
      if (hasSeenEditTool) {
        return false; // Skip this duplicate edit tool
      }
      hasSeenEditTool = true;
    }

    return true;
  });
}

/**
 * Initializes tool call states for a new message containing tool calls.
 * This function is called when we receive a complete message with tool calls,
 * typically in non-streaming scenarios or when processing the first chunk
 * of a streaming message that contains tool calls.
 *
 * @param message - The chat message containing tool calls to process
 * @param lastItem - The chat history item to attach tool call states to
 */
export function handleToolCallsInMessage(
  message: ChatMessage,
  lastItem: ChatHistoryItemWithMessageId,
): void {
  if (
    (message.role === "assistant" || message.role === "thinking") &&
    message.toolCalls?.length
  ) {
    // Filter out duplicate edit/search-replace tool calls - only keep the first one
    const filteredToolCalls = filterMultipleEditToolCalls(message.toolCalls);

    // Initialize tool call states for each filtered tool call in the message
    // Each tool call gets its own state to track generation/execution progress
    lastItem.toolCallStates = filteredToolCalls.map((toolCallDelta) =>
      addToolCallDeltaToState(toolCallDelta, undefined),
    );

    // Update the message's toolCalls array to reflect the processed tool calls
    // We can safely cast because we verified the role above
    const curMessage = lastItem.message as
      | AssistantChatMessage
      | ThinkingChatMessage;
    curMessage.toolCalls = lastItem.toolCallStates.map(
      (state) => state.toolCall,
    );
  }
}

/**
 * Applies a single tool call delta to the tool call states array.
 *
 * This function handles the core logic for OpenAI-style tool call streaming where:
 * - Initial tool calls come with full details (ID, name, arguments)
 * - Subsequent argument fragments come without IDs and need to update the most recent tool call
 * - Multiple parallel tool calls can be streamed simultaneously
 *
 * @param toolCallDelta - The incoming tool call delta from the LLM stream
 * @param toolCallStates - Array of existing tool call states (modified in place)
 */
function applyToolCallDelta(
  toolCallDelta: ToolCallDelta,
  toolCallStates: ToolCallState[],
): void {
  // Find existing state by matching toolCallId - this ensures we update
  // the correct tool call even when multiple tool calls are being streamed
  let existingStateIndex = -1;

  if (toolCallDelta.id) {
    // Tool call has an ID - find by exact match
    // This handles: new tool calls or explicit updates to existing ones
    existingStateIndex = toolCallStates.findIndex(
      (state) => state.toolCallId === toolCallDelta.id,
    );
  } else {
    // No ID in delta (common in OpenAI streaming fragments)
    // Strategy: Update the most recently added tool call that's still being generated
    // This handles the pattern: initial tool call with ID, then fragments without ID
    existingStateIndex = toolCallStates.length - 1;

    // Ensure we have at least one tool call to update
    if (existingStateIndex < 0) {
      existingStateIndex = -1; // Will create new tool call
    }
  }

  const existingState =
    existingStateIndex >= 0 ? toolCallStates[existingStateIndex] : undefined;

  // Apply the delta to create an updated state (either updating existing or creating new)
  const updatedState = addToolCallDeltaToState(toolCallDelta, existingState);

  if (existingStateIndex >= 0) {
    // Update existing tool call state in place
    toolCallStates[existingStateIndex] = updatedState;
  } else {
    // Add new tool call state for a newly discovered tool call
    toolCallStates.push(updatedState);
  }
}

/**
 * Handles incremental updates to tool calls during streaming responses.
 * This function processes streaming deltas for tool calls, updating existing
 * tool call states or creating new ones as needed. It uses ID-based matching
 * to ensure tool call updates are applied to the correct tool call state.
 *
 * @param message - The streaming message chunk containing tool call deltas
 * @param lastItem - The chat history item containing existing tool call states
 */
export function handleStreamingToolCallUpdates(
  message: ChatMessage,
  lastItem: ChatHistoryItemWithMessageId,
): void {
  if (
    message.role === "assistant" &&
    message.toolCalls?.length &&
    lastItem.message.role === "assistant"
  ) {
    // Start with existing tool call states or empty array if none exist
    const existingToolCallStates = lastItem.toolCallStates || [];
    const updatedToolCallStates: ToolCallState[] = [...existingToolCallStates];

    // Filter out duplicate edit/search-replace tool calls - only keep the first one
    const filteredToolCalls = filterMultipleEditToolCalls(message.toolCalls);

    // Process each filtered tool call delta, matching by ID to update the correct state
    filteredToolCalls.forEach((toolCallDelta) => {
      applyToolCallDelta(toolCallDelta, updatedToolCallStates);
    });

    // Replace the entire tool call states array with the updated version
    lastItem.toolCallStates = updatedToolCallStates;

    // Update the message's toolCalls array to reflect current tool call states
    (lastItem.message as any).toolCalls = updatedToolCallStates.map(
      (state) => state.toolCall,
    );
  }
}

// We need this to handle reorderings (e.g. a mid-array deletion) of the messages array.
// The proper fix is adding a UUID to all chat messages, but this is the temp workaround.
export type ChatHistoryItemWithMessageId = ChatHistoryItem & {
  message: ChatMessage & { id: string };
  /**
   * A local transcript receipt for a real broker-model transition. It is a
   * system message so it is retained with session history but never sent to a
   * vendor as conversational context.
   */
  modelSwitch?: {
    model: BrokerModel;
    displayName: string;
  };
  /** Messenger-style receipt persisted on every newly sent user message. */
  messageReceipt?: {
    sentAt: number;
    status: "queued" | "delivered" | "read" | "deferred" | "failed";
  };
  isSteer?: boolean;
  /**
   * `delivered` means the native bridge accepted the follow-up. `read` is
   * reserved for an explicit vendor echo of this exact input, never for an
   * arbitrary later assistant/tool event.
   */
  steerStatus?: "queued" | "delivered" | "read" | "deferred" | "failed";
  /** Epoch milliseconds captured at send time and persisted with history. */
  steerSentAt?: number;
  // Set on the last kept assistant turn when the user cancels (Esc). Drives the
  // turn-level "Interrupted" marker for text/thinking streams that have no
  // in-flight tool call to carry the label.
  interrupted?: boolean;
};

/**
 * History predates message receipts. Never manufacture a timestamp from
 * reload time: it would make an old message look newly sent. A legacy steer
 * with no explicit status is conservatively failed/unconfirmed.
 */
export function normalizeRestoredHistory(
  history: ChatHistoryItemWithMessageId[],
): ChatHistoryItemWithMessageId[] {
  return history.map(({ modelSwitch, ...item }) => {
    const normalizedModelSwitch =
      modelSwitch &&
      typeof modelSwitch.model === "string" &&
      typeof modelSwitch.displayName === "string" &&
      modelSwitch.model.trim() &&
      modelSwitch.displayName.trim()
        ? {
            model: modelSwitch.model,
            displayName: canonicalCukiiModelLabel(
              modelSwitch.model,
              modelSwitch.displayName,
            ),
          }
        : undefined;
    const receipt = item.messageReceipt;
    const sentAt = item.steerSentAt;
    if (receipt && Number.isFinite(receipt.sentAt)) {
      return normalizedModelSwitch
        ? { ...item, modelSwitch: normalizedModelSwitch }
        : item;
    }
    if (!item.isSteer) {
      return normalizedModelSwitch
        ? { ...item, modelSwitch: normalizedModelSwitch }
        : item;
    }
    const normalized = {
      ...item,
      messageReceipt: Number.isFinite(sentAt)
        ? { sentAt: sentAt!, status: item.steerStatus ?? "failed" }
        : undefined,
      steerSentAt: Number.isFinite(sentAt) ? sentAt : undefined,
      steerStatus: item.steerStatus ?? "failed",
    };
    return normalizedModelSwitch
      ? { ...normalized, modelSwitch: normalizedModelSwitch }
      : normalized;
  });
}

function finishActiveThinking(history: ChatHistoryItemWithMessageId[]): void {
  const active = history.findLast((item) => item.reasoning?.active);
  if (active?.reasoning?.active) {
    active.reasoning.active = false;
    active.reasoning.endAt = Date.now();
  }
}

/**
 * A stored preference belongs to its former vendor. On a model switch retain
 * it only where the target CLI verifies it; otherwise use that vendor's
 * visible Bypass default when available (Kimi's prompt-mode route), before any
 * subsequent turn can read the state.
 */
function reconcilePermissionModeForBrokerModel(
  model: BrokerModel,
  current: CukiiPermissionMode,
): CukiiPermissionMode {
  const capabilities = defaultVendorPermissionCapabilities(
    brokerVendorForModel(model),
  );
  if (capabilities.supportedModes.includes(current)) return current;
  if (capabilities.supportedModes.includes("bypass")) return "bypass";
  return resolvePermissionModeForVendor(capabilities, current);
}

/**
 * Restore has one intentionally narrow repair: a vendor with exactly one
 * verified visible noninteractive mode, Bypass. A persisted Manual from a
 * former route would otherwise reach bridgeControls before async discovery.
 * Claude Manual and unknown/empty capability routes stay fail-closed.
 */
export function reconcileRestoredPermissionMode(
  model: BrokerModel,
  current: CukiiPermissionMode,
): CukiiPermissionMode {
  const capabilities = defaultVendorPermissionCapabilities(
    brokerVendorForModel(model),
  );
  const bypassOnly =
    capabilities.supportedModes.length === 1 &&
    capabilities.supportedModes[0] === "bypass";
  return bypassOnly && current !== "bypass" ? "bypass" : current;
}

/** An explicit native-worker pause, carried separately from chat text. */
export type CukiiBridgeWait = {
  condition: string;
  deadline?: string;
};

type SessionState = {
  lastSessionId?: string;
  isSessionLoading: boolean;
  isSessionMetadataLoading: boolean;
  allSessionMetadata: BaseSessionMetadata[];
  history: ChatHistoryItemWithMessageId[];
  isStreaming: boolean;
  isCancelling?: boolean;
  /** Ephemeral per-tab state; deliberately excluded from persisted Session. */
  bridgeWait?: CukiiBridgeWait;
  title: string;
  titleManuallySet: boolean;
  revision: number;
  id: string;
  streamAborter: AbortController;
  mainEditorContentTrigger?: JSONContent | undefined;
  symbols: FileSymbolMap;
  mode: MessageModes;
  brokerModel?: BrokerModel;
  brokerSubagent?: BrokerSubagent;
  brokerEffort: BrokerEffort;
  brokerSpeed: BrokerSpeed;
  brokerPermissionMode: CukiiPermissionMode;
  /** Keyed by run/request so parallel Claude tools cannot overwrite each other. */
  pendingClaudePermissions: Record<string, CukiiClaudePermissionRequest>;
  isInEdit: boolean;
  codeBlockApplyStates: {
    states: ApplyState[];
    curIndex: number;
  };
  newestToolbarPreviewForInput: Record<string, string>;
  hasReasoningEnabled: boolean;
  isPruned?: boolean;
  contextPercentage?: number;
  inlineErrorMessage?: InlineErrorMessageType;
  compactionLoading: Record<number, boolean>; // Track compaction loading by message index
};

export type {
  BrokerEffort,
  BrokerModel,
  BrokerSpeed,
  BrokerSubagent,
  CukiiPermissionMode,
} from "core/protocol/ideWebview";

export const INITIAL_SESSION_STATE: SessionState = {
  isSessionLoading:
    typeof window !== "undefined" &&
    window.cukiiSurface === "chat" &&
    Boolean(window.initialSessionId),
  isSessionMetadataLoading: false,
  allSessionMetadata: [],
  history: [],
  isStreaming: false,
  isCancelling: false,
  bridgeWait: undefined,
  title: NEW_SESSION_TITLE,
  titleManuallySet: false,
  revision: 0,
  id: uuidv4(),
  streamAborter: new AbortController(),
  symbols: {},
  mode: "broker",
  brokerModel: "opus-5",
  brokerSubagent: "auto",
  brokerEffort: "high",
  brokerSpeed: "standard",
  brokerPermissionMode: "bypass",
  pendingClaudePermissions: {},
  hasReasoningEnabled: true,
  isInEdit: false,
  codeBlockApplyStates: {
    states: [],
    curIndex: 0,
  },
  lastSessionId: undefined,
  newestToolbarPreviewForInput: {},
  compactionLoading: {},
};

export const sessionSlice = createSlice({
  name: "session",
  initialState: INITIAL_SESSION_STATE,
  reducers: {
    addPromptCompletionPair: (
      state,
      { payload }: PayloadAction<PromptLog[]>,
    ) => {
      if (!state.history.length) {
        return;
      }

      const lastMessage = state.history[state.history.length - 1];

      lastMessage.promptLogs = lastMessage.promptLogs
        ? lastMessage.promptLogs.concat(payload)
        : payload;

      // Inactive thinking for reasoning models when '</think>' tag is not received on request completion
      if (lastMessage.reasoning?.active) {
        lastMessage.reasoning.active = false;
        lastMessage.reasoning.endAt = Date.now();
      }
    },
    setActive: (state) => {
      state.isStreaming = true;
      state.bridgeWait = undefined;
    },
    setIsGatheringContext: (state, { payload }: PayloadAction<boolean>) => {
      const curMessage = state.history.at(-1);
      if (curMessage) {
        curMessage.isGatheringContext = payload;
      }
    },
    clearDanglingMessages: (
      state,
      action: PayloadAction<"turn" | "tool" | undefined>,
    ) => {
      // This is used during cancellation
      // After the last user or tool message, we can have thinking and or valid assitant message (content or generated tool calls) OR nothing.
      // The only thing allowed after the last assistant message that has either content or generated tool calls
      // is a user or tool message
      if (state.history.length < 2) {
        return;
      }

      const lastUserOrToolIdx = findLastIndex(
        state.history,
        (item) => item.message.role === "tool" || item.message.role === "user",
      );

      let validAssistantMessageIdx = -1;
      for (let i = state.history.length - 1; i > lastUserOrToolIdx; i--) {
        const message = state.history[i];
        // Any in-flight tool call (even still "generating") makes this message
        // worth keeping: we mark it canceled below so the transcript shows
        // "Tool interrupted", instead of silently deleting the turn on Esc.
        const hasToolCalls = (message.toolCallStates?.length ?? 0) > 0;
        const hasReasoning = !!message.reasoning?.text?.trim();
        if (message.message.content || hasToolCalls || hasReasoning) {
          validAssistantMessageIdx = i;
          // Mark the turn interrupted so the transcript shows "Interrupted"
          // even when the cancel happened mid text/thinking (no tool call to
          // carry the per-tool label).
          message.interrupted = action.payload !== "tool";
          // Cancel any tool calls that are dangling and generated
          if (message.toolCallStates) {
            message.toolCallStates.forEach((toolCallState) => {
              if (
                toolCallState.status === "generated" ||
                toolCallState.status === "generating" ||
                toolCallState.status === "calling"
              ) {
                toolCallState.status = "canceled";
                if (!toolCallState.output?.length) {
                  toolCallState.output = [
                    {
                      name: TOOL_INTERRUPTED_MESSAGE,
                      description: TOOL_INTERRUPTED_MESSAGE,
                      content: TOOL_INTERRUPTED_MESSAGE,
                    },
                  ];
                }
              }
            });
          }
          break;
        }
      }

      if (validAssistantMessageIdx === -1) {
        const lastMsg = state.history[lastUserOrToolIdx];
        const lastRole = lastMsg.message.role as "user" | "tool";
        if (lastRole === "user") {
          state.mainEditorContentTrigger = lastMsg.editorState;
          state.history = state.history.slice(0, lastUserOrToolIdx);
        } else {
          state.history = state.history.slice(0, lastUserOrToolIdx + 1);
        }
      } else {
        state.history = state.history.slice(0, validAssistantMessageIdx + 1);
      }
    },
    // Trigger value picked up by editor with isMainInput to set its content
    setMainEditorContentTrigger: (
      state,
      action: PayloadAction<JSONContent | undefined>,
    ) => {
      state.mainEditorContentTrigger = action.payload;
    },
    updateFileSymbols: (state, action: PayloadAction<FileSymbolMap>) => {
      state.symbols = {
        ...state.symbols,
        ...action.payload,
      };
    },
    setContextItemsAtIndex: (
      state,
      {
        payload: { index, contextItems },
      }: PayloadAction<{
        index: number;
        contextItems: ChatHistoryItem["contextItems"];
      }>,
    ) => {
      if (state.history[index]) {
        state.history[index].contextItems = contextItems;
      }
    },
    submitEditorAndInitAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        editorState: JSONContent;
      }>,
    ) => {
      const { index, editorState } = payload;

      if (state.history.length && index < state.history.length) {
        // Resubmission - update input message, truncate history after resubmit with new empty response message
        if (index % 2 === 1) {
          console.warn(
            "Corrupted history: resubmitting at odd index, shouldn't happen",
          );
        }
        const historyItem = state.history[index];

        historyItem.message.content = ""; // IMPORTANT - this is quickly updated by resolveEditorContent based on editor state prior to streaming
        historyItem.editorState = payload.editorState;
        historyItem.contextItems = [];

        state.history = state.history.slice(0, index + 1).concat({
          message: {
            id: uuidv4(),
            role: "assistant",
            content: "", // IMPORTANT - this is subsequently updated by response streaming
          },
          contextItems: [],
        });
      } else {
        // New input/response messages
        state.history = state.history.concat([
          {
            message: {
              id: uuidv4(),
              role: "user",
              content: "", // IMPORTANT - this is quickly updated by resolveEditorContent based on editor state prior to streaming
            },
            contextItems: [],
            editorState,
            messageReceipt: { sentAt: Date.now(), status: "queued" },
          },
          {
            message: {
              id: uuidv4(),
              role: "assistant",
              content: "", // IMPORTANT - this is subsequently updated by response streaming
            },
            contextItems: [],
          },
        ]);
      }

      state.isStreaming = true;
    },
    truncateHistoryToMessage: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
      }>,
    ) => {
      const { index } = payload;

      if (state.history.length && index < state.history.length) {
        state.codeBlockApplyStates.curIndex = 0;
        state.history = state.history.slice(0, index + 1).concat({
          message: {
            id: uuidv4(),
            role: "assistant",
            content: "", // IMPORTANT - this is subsequently updated by response streaming
          },
          contextItems: [],
        });
        state.inlineErrorMessage = undefined;
        state.isPruned = false;
        state.contextPercentage = undefined;
      }
    },
    deleteMessage: (state, action: PayloadAction<number>) => {
      // Deletes the current assistant message and the previous user message
      state.history.splice(action.payload - 1, 2);
      state.inlineErrorMessage = undefined;
      state.isPruned = false;
      state.contextPercentage = undefined;
    },
    deleteCompaction: (state, action: PayloadAction<number>) => {
      // Removes the conversation summary from the specified message
      const historyItem = state.history[action.payload];
      if (historyItem?.conversationSummary) {
        state.history[action.payload] = {
          ...historyItem,
          conversationSummary: undefined,
        };
      }
    },
    updateHistoryItemAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        updates: Partial<ChatHistoryItemWithMessageId>;
      }>,
    ) => {
      const { index, updates } = payload;
      if (index !== 0 && !state.history[index]) {
        console.error(
          `attempting to update history item at nonexistent index ${index}`,
          updates,
        );
        return;
      }
      state.history[index] = {
        ...state.history[index],
        ...updates,
      };
    },
    addContextItemsAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        contextItems: ContextItemWithId[];
      }>,
    ) => {
      const historyItem = state.history[payload.index];

      if (!historyItem) {
        return;
      }

      historyItem.contextItems = [
        ...historyItem.contextItems,
        ...payload.contextItems,
      ];
    },
    setAppliedRulesAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        appliedRules: RuleMetadata[];
      }>,
    ) => {
      if (state.history[payload.index]) {
        state.history[payload.index].appliedRules = payload.appliedRules;
      }
    },
    setInactive: (state) => {
      const curMessage = state.history.at(-1);

      if (curMessage) {
        curMessage.isGatheringContext = false;
      }

      finishActiveThinking(state.history);
      state.isStreaming = false;
      state.isCancelling = false;
      state.bridgeWait = undefined;
    },
    setCancelling: (state, action: PayloadAction<boolean>) => {
      state.isCancelling = action.payload;
    },
    appendUserSteerMessage: (
      state,
      action: PayloadAction<{
        content: ChatMessage["content"];
        messageId: string;
        editorState?: JSONContent;
        contextItems?: ContextItemWithId[];
      }>,
    ) => {
      if (!state.isStreaming) {
        return;
      }
      state.history.push({
        message: {
          id: action.payload.messageId,
          role: "user",
          content: action.payload.content,
        },
        contextItems: action.payload.contextItems ?? [],
        editorState: action.payload.editorState,
        isSteer: true,
        steerStatus: "queued",
        steerSentAt: Date.now(),
        messageReceipt: { sentAt: Date.now(), status: "queued" },
      });
    },
    setSteerStatus: (
      state,
      action: PayloadAction<{
        messageId: string;
        status: NonNullable<ChatHistoryItemWithMessageId["steerStatus"]>;
      }>,
    ) => {
      const item = state.history.find(
        (entry) => entry.message.id === action.payload.messageId,
      );
      if (item?.isSteer) item.steerStatus = action.payload.status;
      if (item?.messageReceipt)
        item.messageReceipt.status = action.payload.status;
    },
    markSteerRead: (state, action: PayloadAction<{ messageId: string }>) => {
      const item = state.history.find(
        (entry) => entry.message.id === action.payload.messageId,
      );
      // A delayed/duplicate transport frame must not upgrade a message which
      // was never accepted by the bridge in the first place.
      if (item?.isSteer && item.steerStatus === "delivered") {
        item.steerStatus = "read";
      }
      if (item?.messageReceipt?.status === "delivered") {
        item.messageReceipt.status = "read";
      }
    },
    markLatestUserReceiptDelivered: (state) => {
      const item = state.history.findLast(
        (entry) => entry.message.role === "user" && !entry.isSteer,
      );
      if (item?.messageReceipt?.status === "queued") {
        item.messageReceipt.status = "delivered";
      }
    },
    abortStream: (state) => {
      state.streamAborter.abort();
      state.streamAborter = new AbortController();
      // Safety: any path that aborts the stream must also clear the streaming
      // flag. This prevents the bottom loader from staying visible if a race
      // or bridge error leaves isStreaming stuck to true.
      finishActiveThinking(state.history);
      state.isStreaming = false;
      state.isCancelling = false;
      state.bridgeWait = undefined;
    },
    setBridgeWait: (
      state,
      action: PayloadAction<CukiiBridgeWait | undefined>,
    ) => {
      state.bridgeWait = action.payload;
    },
    streamUpdate: (state, action: PayloadAction<ChatMessage[]>) => {
      // Every actual bridge message proves the worker resumed. Silence is not
      // an event and must leave the animated loader alone.
      if (action.payload.length) {
        state.bridgeWait = undefined;
      }
      if (state.history.length) {
        for (const message of action.payload) {
          let lastItem = state.history[state.history.length - 1];
          let lastMessage = lastItem.message;

          if (message.role === "thinking" && message.redactedThinking) {
            state.history.push({
              message: {
                role: "thinking",
                content: "internal reasoning is hidden due to safety reasons",
                redactedThinking: message.redactedThinking,
                id: uuidv4(),
              },
              contextItems: [],
            });
            continue;
          }

          const messageContent = message.content
            ? renderChatMessage(message)
            : "";

          // OpenAI-compatible models in agent mode sometimes send
          // all of their data in one message, so we handle that case early.
          if (messageContent && message.role !== "tool") {
            const thinkMatches = messageContent.match(
              /<think>([\s\S]*)<\/think>([\s\S]*)/,
            );
            if (thinkMatches) {
              // The order that they seem to consistently use is:
              //
              // <think>Thinking text</think>
              // Text to show to the user

              lastItem.reasoning = {
                text: thinkMatches[1].trim(),
                startAt: Date.now(),
                endAt: Date.now(),
                active: false,
              };

              // This is the chat message that we should show to the user.
              // We always need to push this even if it is empty,
              // because we cannot attach tool calls to a Thinking message.
              // That would break `messageHasToolCallId`.
              state.history.push({
                message: {
                  role: "assistant",
                  content: thinkMatches[2].trim(),
                  id: uuidv4(),
                },
                contextItems: [],
              });
              lastItem = state.history[state.history.length - 1];
              lastMessage = lastItem.message;

              handleToolCallsInMessage(message, lastItem);

              return;
            }
          }

          // The remainder of this function handles streaming messages
          if (
            lastMessage.role !== message.role ||
            message.role === "tool" // Tool messages should always create new messages
          ) {
            if (lastMessage.role === "thinking" && lastItem.reasoning?.active) {
              lastItem.reasoning.active = false;
              lastItem.reasoning.endAt = Date.now();
            }
            // Create a new message
            const historyItem: ChatHistoryItemWithMessageId = {
              message: {
                ...message,
                content: "", // Start with empty content, let accumulation logic handle it
                id: uuidv4(),
              },
              contextItems: [],
            };
            if (message.role === "thinking") {
              historyItem.reasoning = {
                text: "",
                startAt: Date.now(),
                active: true,
              };
            }
            state.history.push(historyItem);
            lastItem = state.history[state.history.length - 1];
            lastMessage = lastItem.message;
          }

          // Add to the existing message
          if (messageContent) {
            if (messageContent.includes("<think>") && message.role !== "tool") {
              lastItem.reasoning = {
                startAt: Date.now(),
                active: true,
                text: messageContent.replace("<think>", "").trim(),
              };
            } else if (
              lastItem.reasoning?.active &&
              messageContent.includes("</think>")
            ) {
              const [reasoningEnd, answerStart] =
                messageContent.split("</think>");
              lastItem.reasoning.text += reasoningEnd.trimEnd();
              lastItem.reasoning.active = false;
              lastItem.reasoning.endAt = Date.now();
              lastMessage.content += answerStart.trimStart();
            } else if (lastItem.reasoning?.active) {
              if (
                lastItem.reasoning.text.length > 0 ||
                messageContent.trim().length > 0
              ) {
                lastItem.reasoning.text += messageContent;
              }
            } else {
              // Note this only works because new message above
              // was already rendered from parts to string
              if (
                lastMessage.content.length > 0 ||
                messageContent.trim().length > 0
              ) {
                lastMessage.content += messageContent;
              }
            }
          } else if (message.role === "thinking" && message.signature) {
            if (lastMessage.role === "thinking") {
              lastMessage.signature = message.signature;
            }
          } else if (
            message.role === "assistant" &&
            message.toolCalls?.length &&
            lastMessage.role === "assistant"
          ) {
            handleStreamingToolCallUpdates(message, lastItem);
          }

          // Attach Responses API output item id to the current assistant message if present
          // fromResponsesChunk sets message.metadata.responsesOutputItemId when it sees output_item.added for messages
          if (
            message.role === "assistant" &&
            lastMessage.role === "assistant" &&
            message.metadata?.responsesOutputItemId
          ) {
            lastMessage.metadata = lastMessage.metadata || {};
            // Accumulate fc_ IDs for parallel tool calls (OpenAI Responses API)
            if (!lastMessage.metadata.responsesOutputItemIds) {
              lastMessage.metadata.responsesOutputItemIds = [];
            }
            (lastMessage.metadata.responsesOutputItemIds as string[]).push(
              message.metadata.responsesOutputItemId as string,
            );
            // Also keep singular for backwards compatibility
            lastMessage.metadata.responsesOutputItemId = message.metadata
              .responsesOutputItemId as string;
          }

          if (
            message.role === "thinking" &&
            message.reasoning_details &&
            lastMessage.role === "thinking"
          ) {
            lastMessage.reasoning_details = mergeReasoningDetails(
              lastMessage.reasoning_details,
              message.reasoning_details,
            );
          }
        }
      }
    },
    newSession: (state, { payload }: PayloadAction<Session | undefined>) => {
      state.lastSessionId = state.id;

      state.streamAborter.abort();
      state.streamAborter = new AbortController();

      state.isStreaming = false;
      state.isCancelling = false;
      state.bridgeWait = undefined;
      state.isSessionLoading = false;
      state.symbols = {};

      state.inlineErrorMessage = undefined;
      state.isPruned = false;
      state.contextPercentage = undefined;

      if (payload) {
        state.history = normalizeRestoredHistory(payload.history as any);
        state.title = payload.title;
        state.titleManuallySet = Boolean(payload.titleManuallySet);
        state.revision = payload.revision ?? 0;
        state.id = payload.sessionId;
        if (payload.mode) {
          state.mode = payload.mode;
        }
        state.brokerModel = payload.brokerModel ?? "opus-5";
        state.brokerSubagent = payload.brokerSubagent ?? "auto";
        state.brokerEffort = payload.brokerEffort ?? "high";
        state.brokerSpeed = payload.brokerSpeed ?? "standard";
        state.hasReasoningEnabled = payload.hasReasoningEnabled ?? true;
        // Restored vendors normally keep their saved draft while live
        // discovery is pending. Kimi is the exception: its only verified
        // headless prompt-mode route is Bypass, so stale Manual must not
        // reach bridgeControls before the picker is opened.
        state.brokerPermissionMode =
          payload.brokerPermissionMode === undefined
            ? "bypass"
            : reconcileRestoredPermissionMode(
                state.brokerModel,
                coerceStoredPermissionMode(payload.brokerPermissionMode),
              );
      } else {
        state.history = [];
        state.title = NEW_SESSION_TITLE;
        state.titleManuallySet = false;
        state.revision = 0;
        state.id = uuidv4();
        state.mode = "broker";
        state.brokerModel = "opus-5";
        state.brokerSubagent = "auto";
        state.brokerEffort = "high";
        state.brokerSpeed = "standard";
        state.brokerPermissionMode = "bypass";
        state.hasReasoningEnabled = true;
      }
    },
    updateSessionTitle: (state, { payload }: PayloadAction<string>) => {
      state.title = payload;
    },
    setTitleManuallySet: (state, { payload }: PayloadAction<boolean>) => {
      state.titleManuallySet = payload;
    },
    setSessionRevision: (
      state,
      { payload }: PayloadAction<{ sessionId: string; revision: number }>,
    ) => {
      if (state.id === payload.sessionId) {
        state.revision = payload.revision;
      }
    },
    setIsSessionMetadataLoading: (
      state,
      { payload }: PayloadAction<boolean>,
    ) => {
      state.isSessionMetadataLoading = payload;
    },
    setIsSessionLoading: (state, { payload }: PayloadAction<boolean>) => {
      state.isSessionLoading = payload;
    },
    setAllSessionMetadata: (
      state,
      { payload }: PayloadAction<BaseSessionMetadata[]>,
    ) => {
      state.allSessionMetadata = payload;
    },
    //////////////////////////////////////////////////////////////////////////////////
    // These are for optimistic session metadata updates, especially for History page
    addSessionMetadata: (
      state,
      { payload }: PayloadAction<BaseSessionMetadata>,
    ) => {
      state.allSessionMetadata = [...state.allSessionMetadata, payload];
    },
    updateSessionMetadata: (
      state,
      {
        payload,
      }: PayloadAction<
        {
          sessionId: string;
        } & Partial<BaseSessionMetadata>
      >,
    ) => {
      state.allSessionMetadata = state.allSessionMetadata.map((session) =>
        session.sessionId === payload.sessionId
          ? {
              ...session,
              ...payload,
            }
          : session,
      );
      if (payload.title && payload.sessionId === state.id) {
        state.title = payload.title;
      }
    },
    deleteSessionMetadata: (state, { payload }: PayloadAction<string>) => {
      // Note, should not be allowed to delete current session from chat session
      state.allSessionMetadata = state.allSessionMetadata.filter(
        (session) => session.sessionId !== payload,
      );
    },
    //////////////////////////////////////////////////////////////////////////////////
    addHighlightedCode: (
      state,
      {
        payload,
      }: PayloadAction<{ rangeInFileWithContents: any; edit: boolean }>,
    ) => {
      let contextItems =
        state.history[state.history.length - 1].contextItems ?? [];

      contextItems = contextItems.map((item) => {
        return { ...item, editing: false };
      });

      const { relativePathOrBasename } = findUriInDirs(
        payload.rangeInFileWithContents.filepath,
        window.workspacePaths ?? [],
      );
      const fileName = getUriPathBasename(
        payload.rangeInFileWithContents.filepath,
      );

      const lineNums = `(${
        payload.rangeInFileWithContents.range.start.line + 1
      }-${payload.rangeInFileWithContents.range.end.line + 1})`;

      contextItems.push({
        name: `${fileName} ${lineNums}`,
        description: relativePathOrBasename,
        id: {
          providerTitle: "code",
          itemId: uuidv4(),
        },
        content: payload.rangeInFileWithContents.contents,
        editing: true,
        editable: true,
        uri: {
          type: "file",
          value: payload.rangeInFileWithContents.filepath,
        },
      });

      state.history[state.history.length - 1].contextItems = contextItems;
    },
    updateApplyState: (state, { payload }: PayloadAction<ApplyState>) => {
      const applyState = state.codeBlockApplyStates.states.find(
        (state) => state.streamId === payload.streamId,
      );

      if (!applyState) {
        state.codeBlockApplyStates.states.push(payload);
      } else {
        applyState.status = payload.status ?? applyState.status;
        applyState.numDiffs = payload.numDiffs ?? applyState.numDiffs;
        applyState.filepath = payload.filepath ?? applyState.filepath;
        applyState.fileContent = payload.fileContent ?? applyState.fileContent;
        applyState.originalFileContent =
          payload.originalFileContent ?? applyState.originalFileContent;
      }

      if (payload.status === "done") {
        state.codeBlockApplyStates.curIndex++;
      }
    },
    resetNextCodeBlockToApplyIndex: (state) => {
      state.codeBlockApplyStates.curIndex = 0;
    },

    // TOOL CALL STATE
    setToolGenerated: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        tools: Tool[];
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );

      if (toolCallState) {
        toolCallState.status = "generated";

        const tool = action.payload.tools.find(
          (t) => t.function.name === toolCallState.toolCall.function.name,
        );
        if (tool) {
          toolCallState.tool = tool;
        }
      }
    },
    updateToolCallOutput: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        contextItems: ContextItem[];
        mcpUiState?: McpUiState;
      }>,
    ) => {
      // Update tool call state and corresponding tool output message
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.output = action.payload.contextItems;
        toolCallState.mcpUiState = action.payload.mcpUiState;
      }
      const toolItem = findChatHistoryItemByToolCallId(
        state.history,
        action.payload.toolCallId,
      );
      if (toolItem) {
        toolItem.message.content = renderContextItems(
          action.payload.contextItems,
        );
        toolItem.contextItems = action.payload.contextItems.map((item) =>
          toolCallCtxItemToCtxItemWithId(item, action.payload.toolCallId),
        );
      }
    },
    setProcessedToolCallArgs: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        newArgs: Record<string, any>;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.processedArgs = action.payload.newArgs;
      }
    },
    cancelToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "canceled";
      }
    },
    errorToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        output?: ContextItem[]; // optional for convenience
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "errored";
        if (action.payload.output) {
          toolCallState.output = action.payload.output;
        }
      }
    },
    acceptToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "done";
      }
    },
    setToolCallCalling: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "calling";
      }
    },
    setMode: (state, action: PayloadAction<MessageModes>) => {
      state.mode = action.payload;
    },
    setBrokerModel: (state, action: PayloadAction<BrokerModel>) => {
      state.brokerModel = action.payload;
    },
    /**
     * Model choice is a persistent transcript boundary. Keep it separate from
     * setBrokerModel because restore/draft hydration must not manufacture an
     * event, while every user-initiated transition must be visible.
     */
    switchBrokerModel: (
      state,
      action: PayloadAction<{ model: BrokerModel; displayName: string }>,
    ) => {
      const { model, displayName } = action.payload;
      if ((state.brokerModel ?? "opus-5") === model) return;

      state.brokerModel = model;
      state.brokerPermissionMode = reconcilePermissionModeForBrokerModel(
        model,
        state.brokerPermissionMode,
      );
      state.history.push({
        message: {
          id: uuidv4(),
          role: "system",
          content: "",
        },
        contextItems: [],
        modelSwitch: {
          model,
          displayName: canonicalCukiiModelLabel(model, displayName || model),
        },
      });
    },
    setBrokerSubagent: (state, action: PayloadAction<BrokerSubagent>) => {
      state.brokerSubagent = action.payload;
    },
    setBrokerEffort: (state, action: PayloadAction<BrokerEffort>) => {
      state.brokerEffort = action.payload;
    },
    setBrokerSpeed: (state, action: PayloadAction<BrokerSpeed>) => {
      state.brokerSpeed = action.payload;
    },
    setIsInEdit: (state, action: PayloadAction<boolean>) => {
      state.isInEdit = action.payload;
    },
    setHasReasoningEnabled: (state, action: PayloadAction<boolean>) => {
      state.hasReasoningEnabled = action.payload;
    },
    setBrokerPermissionMode: (
      state,
      action: PayloadAction<CukiiPermissionMode>,
    ) => {
      state.brokerPermissionMode = action.payload;
    },
    enqueueClaudePermission: (
      state,
      action: PayloadAction<CukiiClaudePermissionRequest>,
    ) => {
      const request = action.payload;
      state.pendingClaudePermissions[`${request.runId}:${request.requestId}`] =
        request;
    },
    removeClaudePermission: (
      state,
      action: PayloadAction<{ runId: string; requestId: string }>,
    ) => {
      delete state.pendingClaudePermissions[
        `${action.payload.runId}:${action.payload.requestId}`
      ];
    },
    clearClaudePermissions: (state) => {
      state.pendingClaudePermissions = {};
    },
    setNewestToolbarPreviewForInput: (
      state,
      {
        payload,
      }: PayloadAction<{
        inputId: string;
        contextItemId: string;
      }>,
    ) => {
      state.newestToolbarPreviewForInput[payload.inputId] =
        payload.contextItemId;
    },
    setCompactionLoading: (
      state,
      action: PayloadAction<{ index: number; loading: boolean }>,
    ) => {
      const { index, loading } = action.payload;
      if (loading) {
        state.compactionLoading[index] = true;
      } else {
        delete state.compactionLoading[index];
      }
    },
    setInlineErrorMessage: (
      state,
      action: PayloadAction<SessionState["inlineErrorMessage"]>,
    ) => {
      state.inlineErrorMessage = action.payload;
    },
    setIsPruned: (state, action: PayloadAction<boolean>) => {
      state.isPruned = action.payload;
    },
    setContextPercentage: (state, action: PayloadAction<number>) => {
      state.contextPercentage = action.payload;
    },
  },
  selectors: {
    selectIsGatheringContext: (state) => {
      const curHistoryItem = state.history.at(-1);
      return curHistoryItem?.isGatheringContext || false;
    },
  },
  extraReducers: (builder) => {
    addPassthroughCases(builder, [streamResponseThunk]);
  },
});

function addPassthroughCases(
  builder: ActionReducerMapBuilder<SessionState>,
  thunks: AsyncThunk<any, any, any>[],
) {
  thunks.forEach((thunk) => {
    builder
      .addCase(thunk.fulfilled, (_state, _action) => {})
      .addCase(thunk.rejected, (_state, _action) => {})
      .addCase(thunk.pending, (_state, _action) => {});
  });
}

export const selectApplyStateByStreamId = createSelector(
  [
    (state: RootState) => state.session.codeBlockApplyStates.states,
    (_state: RootState, streamId?: string) => streamId,
  ],
  (states, streamId) => {
    return states.find((state) => state.streamId === streamId);
  },
);

export const selectApplyStateByToolCallId = createSelector(
  [
    (state: RootState) => state.session.codeBlockApplyStates.states,
    (_state: RootState, toolCallId?: string) => toolCallId,
  ],
  (states, toolCallId) => {
    if (toolCallId) {
      return states.find((state) => state.toolCallId === toolCallId);
    }
  },
);

export const {
  updateFileSymbols,
  setContextItemsAtIndex,
  addContextItemsAtIndex,
  setAppliedRulesAtIndex,
  setInactive,
  setCancelling,
  appendUserSteerMessage,
  markSteerRead,
  markLatestUserReceiptDelivered,
  setSteerStatus,
  streamUpdate,
  newSession,
  updateSessionTitle,
  setTitleManuallySet,
  setSessionRevision,
  addHighlightedCode,
  addPromptCompletionPair,
  setActive,
  setBridgeWait,
  submitEditorAndInitAtIndex,
  truncateHistoryToMessage,
  updateHistoryItemAtIndex,
  clearDanglingMessages,
  setMainEditorContentTrigger,
  deleteMessage,
  deleteCompaction,
  setIsGatheringContext,
  resetNextCodeBlockToApplyIndex,
  updateApplyState,
  abortStream,
  setToolCallCalling,
  cancelToolCall,
  errorToolCall,
  acceptToolCall,
  setToolGenerated,
  updateToolCallOutput,
  setProcessedToolCallArgs,
  setMode,
  setBrokerModel,
  switchBrokerModel,
  setBrokerSubagent,
  setBrokerEffort,
  setBrokerSpeed,
  setIsSessionLoading,
  setIsSessionMetadataLoading,
  setAllSessionMetadata,
  addSessionMetadata,
  updateSessionMetadata,
  deleteSessionMetadata,
  setNewestToolbarPreviewForInput,
  setIsInEdit,
  setHasReasoningEnabled,
  setBrokerPermissionMode,
  enqueueClaudePermission,
  removeClaudePermission,
  clearClaudePermissions,
  setInlineErrorMessage,
  setIsPruned,
  setContextPercentage,
  setCompactionLoading,
} = sessionSlice.actions;

export const { selectIsGatheringContext } = sessionSlice.selectors;

export default sessionSlice.reducer;

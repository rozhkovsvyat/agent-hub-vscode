import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { ContextItem, McpUiState } from "core";
import { CLIENT_TOOLS_IMPLS } from "core/tools/builtIn";
import { ContinueError, ContinueErrorReason } from "core/util/errors";

import { callClientTool } from "../../util/clientTools/callClientTool";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  acceptToolCall,
  errorToolCall,
  setInactive,
  setToolCallCalling,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { findToolCallById, logToolUsage } from "../util";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

export const callToolById = createAsyncThunk<
  void,
  { toolCallId: string; isAutoApproved?: boolean; depth?: number },
  ThunkApiType
>("chat/callTool", async (inputs, { dispatch, extra, getState }) => {
  const { toolCallId, isAutoApproved, depth = 0 } = inputs;

  const state = getState();
  const toolCallState = findToolCallById(state.session.history, toolCallId);
  if (!toolCallState) {
    console.warn(`Tool call with ID ${toolCallId} not found`);
    return;
  }

  if (toolCallState.status !== "generated") {
    return;
  }

  const selectedChatModel = selectSelectedChatModel(state);

  if (!selectedChatModel) {
    throw new Error("No model selected");
  }

  dispatch(
    setToolCallCalling({
      toolCallId,
    }),
  );

  let output: ContextItem[] | undefined = undefined;
  let mcpUiState: McpUiState | undefined = undefined;
  let error: ContinueError | undefined = undefined;
  let streamResponse: boolean;

  // IMPORTANT:
  // Errors that occur while calling tool call implementations
  // Are caught and passed in output as context items
  // Errors that occur outside specifically calling the tool
  // Should not be caught here - should be handled as normal stream errors
  if (
    CLIENT_TOOLS_IMPLS.find(
      (toolName) => toolName === toolCallState.toolCall.function.name,
    )
  ) {
    // Tool is called on client side
    const sessionId = getState().session.id;
    const hookInput = toolCallState.parsedArgs as Record<string, unknown>;
    const preHook = await extra.ideMessenger.request("tools/runHook", {
      event: "PreToolUse",
      sessionId,
      toolCall: toolCallState.toolCall,
      toolInput: hookInput,
    });
    if (preHook.status === "error") {
      throw new Error(preHook.error);
    }
    if (preHook.content.blocked) {
      output = [];
      error = new ContinueError(
        ContinueErrorReason.Unspecified,
        preHook.content.reason || "Blocked by hook",
      );
      streamResponse = true;
    } else {
      // Client-side edit implementations write directly through the IDE. They
      // do not have Core's second policy gate, so input rewriting is fail-closed
      // here: a hook may approve/deny an edit, never retarget it after approval.
      if (preHook.content.updatedInput !== undefined) {
        output = [];
        error = new ContinueError(
          ContinueErrorReason.Unspecified,
          "Hook-updated input for a client edit requires a new permission decision and was blocked.",
        );
        streamResponse = true;
      } else {
        const effectiveInput =
          (preHook.content.updatedInput as
            | Record<string, unknown>
            | undefined) ?? hookInput;
        const effectiveToolCallState =
          preHook.content.updatedInput === undefined
            ? toolCallState
            : { ...toolCallState, parsedArgs: effectiveInput };
        const {
          output: clientToolOutput,
          respondImmediately,
          error: clientToolError,
        } = await callClientTool(effectiveToolCallState, {
          dispatch,
          ideMessenger: extra.ideMessenger,
          getState,
        });
        output = clientToolOutput;
        error = clientToolError;
        streamResponse = respondImmediately;
        const postHook = await extra.ideMessenger.request("tools/runHook", {
          event: clientToolError ? "PostToolUseFailure" : "PostToolUse",
          sessionId,
          toolCall: toolCallState.toolCall,
          toolInput: effectiveInput,
          extra: clientToolError
            ? { error: clientToolError.message }
            : { tool_response: clientToolOutput },
        });
        if (postHook.status === "error") {
          throw new Error(postHook.error);
        }
      }
    }
  } else {
    // Tool is called on core side
    const result = await extra.ideMessenger.request("tools/call", {
      toolCall: toolCallState.toolCall,
      sessionId: getState().session.id,
    });
    if (result.status === "error") {
      throw new Error(result.error);
    } else {
      output = result.content.contextItems;
      mcpUiState = result.content.mcpUiState;
      error = result.content.errorMessage
        ? new ContinueError(
            result.content.errorReason || ContinueErrorReason.Unspecified,
            result.content.errorMessage,
          )
        : undefined;
    }
    streamResponse = true;
  }

  if (error) {
    dispatch(
      updateToolCallOutput({
        toolCallId,
        contextItems: [
          {
            icon: "problems",
            name: "Tool Call Error",
            description: "Tool Call Failed",
            content: `${toolCallState.toolCall.function.name} failed with the message: ${error.message}\n\nPlease try something else or request further instructions.`,
            hidden: false,
          },
        ],
      }),
    );
  } else if (output?.length) {
    dispatch(
      updateToolCallOutput({
        toolCallId,
        contextItems: output,
        mcpUiState,
      }),
    );
  }

  if (streamResponse) {
    if (error) {
      logToolUsage(toolCallState, false, false, extra.ideMessenger, output);
      dispatch(
        errorToolCall({
          toolCallId,
        }),
      );
    } else {
      logToolUsage(toolCallState, true, true, extra.ideMessenger, output);
      dispatch(
        acceptToolCall({
          toolCallId,
        }),
      );
    }

    // Send to the LLM to continue the conversation
    const wrapped = await dispatch(
      streamResponseAfterToolCall({
        toolCallId,
        depth: depth + 1,
      }),
    );
    unwrapResult(wrapped);
  } else {
    dispatch(setInactive());
  }
});

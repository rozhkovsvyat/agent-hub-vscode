import { ArrowRightIcon } from "@heroicons/react/24/outline";
import { ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { useAppSelector } from "../../../redux/hooks";
import { RootState } from "../../../redux/store";
import FunctionSpecificToolCallDiv from "./FunctionSpecificToolCallDiv";
import { McpAppRenderer } from "./MCPAppRenderer";
import { SimpleToolCallUI } from "./SimpleToolCallUI";
import { TodoListCard } from "./TodoListCard";
import { isTodoWriteToolCall } from "./todoWriteUtils";
import { ToolCallDisplay } from "./ToolCallDisplay";
import {
  CursorBridgeProgress,
  getCursorBridgeProgress,
  isCursorBridgeToolCall,
} from "./CursorBridgeProgress";
import { getIconByName } from "./utils";

interface SingleToolCallDivProps {
  toolCallState: ToolCallState;
  historyIndex: number;
}

export function SingleToolCallDiv({
  toolCallState,
  historyIndex,
}: SingleToolCallDivProps) {
  const availableTools = useAppSelector(
    (state: RootState) => state.config.config.tools,
  );

  const tool = availableTools.find(
    (candidate) =>
      toolCallState.toolCall.function?.name === candidate.function.name,
  );
  const functionName = toolCallState.toolCall.function?.name;
  const icon =
    functionName && tool?.toolCallIcon
      ? getIconByName(tool.toolCallIcon)
      : undefined;

  if (isCursorBridgeToolCall(toolCallState)) {
    return (
      <ToolCallDisplay
        tool={tool}
        toolCallState={toolCallState}
        historyIndex={historyIndex}
      >
        <CursorBridgeProgress toolCallState={toolCallState} />
      </ToolCallDisplay>
    );
  }

  if (toolCallState.mcpUiState) {
    return (
      <ToolCallDisplay
        tool={tool}
        toolCallState={toolCallState}
        historyIndex={historyIndex}
      >
        <McpAppRenderer toolCallState={toolCallState} />
      </ToolCallDisplay>
    );
  }

  if (isTodoWriteToolCall(functionName)) {
    return (
      <ToolCallDisplay
        tool={tool}
        toolCallState={toolCallState}
        historyIndex={historyIndex}
        alwaysShowBody
      >
        <TodoListCard parsedArgs={toolCallState.parsedArgs} />
      </ToolCallDisplay>
    );
  }

  if (icon) {
    return (
      <SimpleToolCallUI
        tool={tool}
        toolCallState={toolCallState}
        icon={toolCallState.status === "generated" ? ArrowRightIcon : icon}
        historyIndex={historyIndex}
        showLeadingIcon={false}
      />
    );
  }

  // Broker/Grok shell tools used to render as nested UnifiedTerminal
  // chrome (chevron + "Terminal" + Run) and collapse the feed. Claude
  // shows one caption row per command on the timeline; match that.
  if (functionName === BuiltInToolNames.RunTerminalCommand) {
    return (
      <SimpleToolCallUI
        tool={tool}
        toolCallState={toolCallState}
        historyIndex={historyIndex}
        showLeadingIcon={false}
      />
    );
  }

  if (
    functionName === BuiltInToolNames.SingleFindAndReplace ||
    functionName === BuiltInToolNames.MultiEdit
  ) {
    return (
      <FunctionSpecificToolCallDiv
        toolCallState={toolCallState}
        historyIndex={historyIndex}
      />
    );
  }

  return (
    <ToolCallDisplay
      tool={tool}
      toolCallState={toolCallState}
      historyIndex={historyIndex}
    >
      <FunctionSpecificToolCallDiv
        toolCallState={toolCallState}
        historyIndex={historyIndex}
      />
    </ToolCallDisplay>
  );
}

interface ToolCallDivProps {
  toolCallStates: ToolCallState[];
  historyIndex: number;
}

export function ToolCallDiv({
  toolCallStates,
  historyIndex,
}: ToolCallDivProps) {
  if (!toolCallStates?.length) {
    return null;
  }

  return toolCallStates.map((toolCallState) => (
    <SingleToolCallDiv
      key={toolCallState.toolCallId}
      toolCallState={toolCallState}
      historyIndex={historyIndex}
    />
  ));
}

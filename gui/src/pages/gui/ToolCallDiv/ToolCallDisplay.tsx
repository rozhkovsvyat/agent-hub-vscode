import { Tool, ToolCallState } from "core";
import { useContext, useMemo, useState } from "react";
import { openContextItem } from "../../../components/mainInput/belowMainInput/ContextItemsPeek";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ToolCallStatusMessage } from "./ToolCallStatusMessage";
import { toolCallStateToContextItems } from "./utils";
import { ToolTruncateHistoryIcon } from "./ToolTruncateHistoryIcon";

interface ToolCallDisplayProps {
  children: React.ReactNode;
  icon: React.ReactNode;
  tool: Tool | undefined;
  toolCallState: ToolCallState;
  historyIndex: number;
}

export function ToolCallDisplay({
  tool,
  toolCallState,
  children,
  icon,
  historyIndex,
}: ToolCallDisplayProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const shownContextItems = useMemo(() => {
    const contextItems = toolCallStateToContextItems(toolCallState);
    return contextItems.filter((item) => !item.hidden);
  }, [toolCallState]);

  const isClickable = shownContextItems.length > 0;
  const live =
    toolCallState.status === "generating" || toolCallState.status === "calling";
  const [open, setOpen] = useState(false);
  const showBody = open || live;

  function handleClick() {
    setOpen((prev) => !prev);
    if (shownContextItems.length === 1 && !open) {
      openContextItem(shownContextItems[0], ideMessenger);
    }
  }

  return (
    <div className="flex min-w-0 flex-col justify-center px-3 py-0.5">
      <div className="flex min-w-0 flex-col">
        <div className="flex flex-row items-center justify-between gap-1.5">
          <div
            className={`flex min-w-0 flex-row items-center gap-2 text-xs transition-colors duration-200 ease-in-out ${
              isClickable || children
                ? "cursor-pointer hover:brightness-125"
                : ""
            }`}
            onClick={isClickable || children ? handleClick : undefined}
            data-testid="tool-call-row"
          >
            <div className="h-4 w-4 flex-shrink-0 font-semibold">{icon}</div>
            {tool?.faviconUrl && (
              <img src={tool.faviconUrl} className="h-4 w-4 rounded-sm" />
            )}
            <ToolCallStatusMessage tool={tool} toolCallState={toolCallState} />
          </div>
          {!!toolCallState.output?.length && (
            <ToolTruncateHistoryIcon historyIndex={historyIndex} />
          )}
        </div>
      </div>
      {showBody && <div className="mt-1">{children}</div>}
    </div>
  );
}

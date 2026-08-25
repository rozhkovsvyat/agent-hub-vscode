import { FolderIcon } from "@heroicons/react/24/outline";
import { ToolCallState } from "core";
import {
  CursorBridgeProgressData,
  formatCursorElapsed,
} from "./CursorBridgeProgress";
import { ToggleWithIcon } from "./ToggleWithIcon";
import { getGroupActionVerb } from "./utils";

interface GroupedToolCallHeaderProps {
  toolCallStates: ToolCallState[];
  activeCalls: ToolCallState[];
  liveSubagent?: CursorBridgeProgressData;
  open: boolean;
  onToggle: () => void;
}

export function GroupedToolCallHeader({
  toolCallStates,
  activeCalls,
  liveSubagent,
  open,
  onToggle,
}: GroupedToolCallHeaderProps) {
  return (
    <div className="mb-2">
      <div
        className="text-description flex cursor-pointer items-center gap-1.5 transition-colors duration-200 ease-in-out hover:brightness-125"
        data-testid="performing-actions"
        onClick={onToggle}
      >
        <ToggleWithIcon
          isToggleable
          icon={FolderIcon}
          open={open}
          onClick={onToggle}
        />
        {liveSubagent ? (
          <>
            <span>Subagent is working</span>
            {liveSubagent.model && (
              <span className="text-description-muted">
                · {liveSubagent.model}
              </span>
            )}
            {formatCursorElapsed(liveSubagent.elapsedSeconds) && (
              <span className="text-description-muted">
                · {formatCursorElapsed(liveSubagent.elapsedSeconds)}
              </span>
            )}
          </>
        ) : (
          <>
            {getGroupActionVerb(toolCallStates)} {activeCalls.length}{" "}
            {activeCalls.length === 1 ? "action" : "actions"}
          </>
        )}
      </div>
    </div>
  );
}

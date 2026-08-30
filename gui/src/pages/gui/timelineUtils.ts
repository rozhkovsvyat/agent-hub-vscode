import { ChatHistoryItem, ToolCallState, ToolStatus } from "core";

export function getToolTimelineClass(
  status: ToolStatus,
  isActive = true,
): string {
  switch (status) {
    case "done":
      return "cukii-timeline-checkpoint";
    case "errored":
    case "canceled":
      return "cukii-timeline-failed";
    case "generated":
      return "cukii-timeline-warning";
    case "generating":
    case "calling":
      return isActive ? "cukii-timeline-current" : "cukii-timeline-event";
    default:
      return "cukii-timeline-event";
  }
}

/**
 * A tool id is the lifecycle owner of the active rail. We derive it from the
 * stable transcript/tool order, so an out-of-order completion cannot leave an
 * older row active alongside the latest call.
 */
export function getActiveTimelineToolId(
  history: readonly ChatHistoryItem[],
): string | undefined {
  for (let messageIndex = history.length - 1; messageIndex >= 0; messageIndex--) {
    const active = getLastInProgressToolCallId(history[messageIndex].toolCallStates);
    if (active) {
      return active;
    }
  }
  return undefined;
}

export function isInProgressToolStatus(status: ToolStatus): boolean {
  return status === "generating" || status === "calling";
}

export function getLastInProgressToolCallId(
  toolCallStates: ToolCallState[] | undefined,
): string | undefined {
  if (!toolCallStates?.length) {
    return undefined;
  }

  for (let i = toolCallStates.length - 1; i >= 0; i--) {
    if (isInProgressToolStatus(toolCallStates[i].status)) {
      return toolCallStates[i].toolCallId;
    }
  }

  return undefined;
}

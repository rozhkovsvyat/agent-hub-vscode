import { ToolCallState, ToolStatus } from "core";

export function getToolTimelineClass(status: ToolStatus): string {
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
      return "cukii-timeline-current";
    default:
      return "cukii-timeline-event";
  }
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

import { ChatHistoryItem, ToolCallState, ToolStatus } from "core";

// Cukii's own harness tools leave their trace elsewhere — read receipts for
// the inbox, the reaction pill for a reaction — so a raw
// "mcp__cukii-question__broker_inbox" card in the transcript is noise.
// request_user_input stays visible: it is the user's question sheet.
const CUKII_SERVICE_TOOLS = new Set([
  "broker_inbox",
  "broker_inbox_ack",
  "react_to_user_message",
]);
const CUKII_SERVER = /(?:^|[^a-z])cukii-question(?:[_.:/]+|__)(\w+)$/i;

export function isCukiiServiceToolName(name: string | undefined): boolean {
  const match = name ? CUKII_SERVER.exec(name) : null;
  return !!match && CUKII_SERVICE_TOOLS.has(match[1]);
}

/** Also Claude's deferred-tool loader when it only loads those tools. */
export function isCukiiServiceToolCall(
  state: Pick<ToolCallState, "toolCall"> | undefined,
): boolean {
  const name = state?.toolCall?.function?.name;
  if (isCukiiServiceToolName(name)) return true;
  if (name !== "ToolSearch") return false;
  let query = "";
  try {
    query = String(
      JSON.parse(state?.toolCall?.function?.arguments || "{}").query ?? "",
    );
  } catch {
    return false;
  }
  if (!query.startsWith("select:")) return false;
  const selected = query
    .slice("select:".length)
    .split(",")
    .map((s) => s.trim());
  return selected.length > 0 && selected.every(isCukiiServiceToolName);
}

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
  for (
    let messageIndex = history.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const toolCallStates = history[messageIndex].toolCallStates;
    if (!toolCallStates) continue;
    for (
      let toolIndex = toolCallStates.length - 1;
      toolIndex >= 0;
      toolIndex--
    ) {
      const tool = toolCallStates[toolIndex];
      if (isInProgressToolStatus(tool.status)) {
        return tool.toolCallId;
      }
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

  const latest = toolCallStates[toolCallStates.length - 1];
  return isInProgressToolStatus(latest.status) ? latest.toolCallId : undefined;
}

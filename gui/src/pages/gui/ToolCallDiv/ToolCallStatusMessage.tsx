import { Tool, ToolCallState } from "core";
import { TOOL_INTERRUPTED_MESSAGE } from "core/tools/constants";

interface ToolCallStatusMessageProps {
  tool: Tool | undefined;
  toolCallState: ToolCallState;
}

/** Поля, которые чаще всего и являются сутью вызова. */
const PRINCIPAL_ARG_KEYS = [
  "file_path",
  "filePath",
  "path",
  "command",
  "pattern",
  "query",
  "url",
  "cmd",
  "file",
  "prompt",
];

function principalArg(args: Record<string, unknown> | undefined): string {
  if (!args) {
    return "";
  }
  for (const key of PRINCIPAL_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const fallback = Object.values(args).find(
    (value) => typeof value === "string" && value.trim(),
  );
  return typeof fallback === "string" ? fallback.trim() : "";
}

function outputLineCount(toolCallState: ToolCallState): number {
  const text = (toolCallState.output ?? [])
    .map((item) => item.content ?? "")
    .join("\n")
    .trim();
  return text ? text.split("\n").length : 0;
}

export function ToolCallStatusMessage({
  tool,
  toolCallState,
}: ToolCallStatusMessageProps) {
  const name =
    tool?.displayTitle ?? toolCallState.toolCall.function?.name ?? "tool";
  const arg = principalArg(toolCallState.parsedArgs);
  const lines = outputLineCount(toolCallState);
  const interrupted = toolCallState.status === "canceled";
  const isShell =
    toolCallState.toolCall.function?.name === "run_terminal_command";

  return (
    <span
      className={`flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0 ${
        isShell ? "cukii-shell-tool-call" : ""
      }`}
      data-testid="tool-call-title"
    >
      <span className="text-foreground flex-shrink-0 font-medium">{name}</span>
      {arg && (
        <span className="text-description-muted min-w-0 truncate" title={arg}>
          {arg}
        </span>
      )}
      {interrupted && (
        <span className="text-description-muted flex-shrink-0">
          {TOOL_INTERRUPTED_MESSAGE}
        </span>
      )}
      {lines > 0 && (
        <span className="text-description-muted text-2xs w-full">
          {lines} lines
        </span>
      )}
    </span>
  );
}

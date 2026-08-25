import { Tool, ToolCallState } from "core";

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
  const pending = toolCallState.status === "generated";
  const failed =
    toolCallState.status === "errored" || toolCallState.status === "canceled";

  return (
    <span
      className="flex min-w-0 items-baseline gap-1.5"
      data-testid="tool-call-title"
    >
      {pending && (
        <span className="text-description-muted flex-shrink-0">wants</span>
      )}
      {failed && (
        <span className="text-description-muted flex-shrink-0">tried</span>
      )}
      <span className="text-foreground flex-shrink-0 font-medium">{name}</span>
      {arg && (
        <span className="text-description min-w-0 truncate" title={arg}>
          {arg}
        </span>
      )}
      {lines > 0 && (
        <span className="text-description-muted text-2xs flex-shrink-0">
          {lines} lines
        </span>
      )}
    </span>
  );
}

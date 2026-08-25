import { ToolCallState } from "core";

export interface CursorBridgeProgressData {
  active?: boolean;
  model?: string;
  phase?: string;
  elapsedSeconds?: number;
  eventCount?: number;
  latestActivity?: string;
  changedFiles: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cursorPayload(
  toolCallState: ToolCallState,
): Record<string, unknown> | undefined {
  for (const item of toolCallState.output ?? []) {
    if (typeof item.content !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(item.content);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Неструктурированный MCP-ответ — это не статус Cursor.
    }
  }
}

export function isCursorBridgeToolCall(toolCallState: ToolCallState): boolean {
  const name = toolCallState.toolCall.function?.name ?? "";
  return /(?:cursor_(?:submit|status|delegate)|broker_(?:delegate|status))$/.test(
    name,
  );
}

function isTerminalStatus(status: string | undefined): boolean {
  if (!status) {
    return false;
  }
  return /(done|complete|success|accepted|finished|fail|error|reject|cancel)/i.test(
    status,
  );
}

export function getCursorBridgeProgress(
  toolCallState: ToolCallState,
): CursorBridgeProgressData | undefined {
  if (!isCursorBridgeToolCall(toolCallState)) {
    return undefined;
  }
  const payload = cursorPayload(toolCallState);
  if (!payload) {
    return undefined;
  }
  const progress = isRecord(payload.progress) ? payload.progress : {};
  const changedFiles = Array.isArray(progress.changed_files)
    ? progress.changed_files.filter(
        (value): value is string => typeof value === "string",
      )
    : typeof payload.changes === "string"
      ? payload.changes.split("\n").filter(Boolean)
      : [];

  const status =
    typeof payload.worker_status === "string"
      ? payload.worker_status
      : typeof payload.status === "string"
        ? payload.status
        : undefined;
  const latestActivity =
    typeof progress.latest_activity === "string"
      ? progress.latest_activity
      : typeof payload.job === "string"
        ? `job ${payload.job}`
        : status;

  return {
    active:
      typeof payload.active === "boolean"
        ? payload.active
        : status
          ? !isTerminalStatus(status)
          : undefined,
    model: typeof payload.model === "string" ? payload.model : undefined,
    phase: typeof progress.phase === "string" ? progress.phase : status,
    elapsedSeconds:
      typeof progress.elapsed_seconds === "number"
        ? progress.elapsed_seconds
        : undefined,
    eventCount:
      typeof progress.event_count === "number"
        ? progress.event_count
        : undefined,
    latestActivity,
    changedFiles,
  };
}

export function formatCursorElapsed(
  seconds: number | undefined,
): string | undefined {
  if (seconds === undefined) {
    return undefined;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function CursorBridgeProgress({
  toolCallState,
}: {
  toolCallState: ToolCallState;
}) {
  const progress = getCursorBridgeProgress(toolCallState);
  if (!progress) {
    return null;
  }

  const elapsed = formatCursorElapsed(progress.elapsedSeconds);
  const label = progress.active
    ? "Subagent is working"
    : progress.phase === "finished"
      ? "Subagent finished"
      : "Subagent started";

  return (
    <div className="text-description-muted ml-6 mt-0.5 flex min-w-0 flex-col gap-0.5 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={
            progress.active ? "text-warning" : "text-description-muted"
          }
        >
          {progress.active ? "●" : "○"}
        </span>
        <span>{label}</span>
        {progress.model && <span>· {progress.model}</span>}
        {elapsed && <span>· {elapsed}</span>}
        {progress.eventCount !== undefined && progress.eventCount > 0 && (
          <span>· {progress.eventCount} events</span>
        )}
      </div>
      {progress.latestActivity && (
        <div className="truncate" title={progress.latestActivity}>
          {progress.latestActivity}
        </div>
      )}
      {progress.changedFiles.length > 0 && (
        <div className="truncate" title={progress.changedFiles.join("\n")}>
          Changed: {progress.changedFiles.join(" · ")}
        </div>
      )}
    </div>
  );
}

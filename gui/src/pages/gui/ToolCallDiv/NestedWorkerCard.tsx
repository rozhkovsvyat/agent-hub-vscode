import { CukiiThinkingGlyph } from "../../../components/cukii/CukiiThinkingGlyph";

export type NestedWorkerStatus = "launching" | "running" | "done" | "failed";

export type NestedWorkerKind = "composer" | "broker" | "log";

export interface NestedWorkerView {
  kind: NestedWorkerKind;
  title: string;
  identity: string;
  status: NestedWorkerStatus;
  lastLine: string;
}

const COMPOSER_HEADER = /^\[Composer 2\.5 job ([^\]]+)\]\s*/;
const BROKER_HEADER =
  /^\[broker ([^/\]]+)\/([^\]]+)\](?: status: ([^\n]+))?\s*/;
const LOG_HEADER = /^\[nested worker ([^\]]+)\]\s*/;
const BROKER_STATUS_LINE = /\[broker [^/\]]+\/[^\]]+\] status: ([^\n]+)/g;

function lastNonEmptyLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? "";
  const brokerLine = last.match(
    /^\[broker [^/\]]+\/[^\]]+\](?: status: (.+))?$/,
  );
  if (brokerLine) {
    return brokerLine[1] ? `status: ${brokerLine[1]}` : "";
  }
  return last;
}

function normalizeStatus(
  raw: string | undefined,
  inProgress: boolean,
  hasBody: boolean,
): NestedWorkerStatus {
  const lower = (raw ?? "").toLowerCase();
  if (/(fail|error|reject|cancel)/.test(lower)) {
    return "failed";
  }
  if (/(done|complete|success|accepted|finished)/.test(lower)) {
    return "done";
  }
  if (/(launch|start|queued|pending)/.test(lower)) {
    return "launching";
  }
  if (inProgress) {
    return hasBody ? "running" : "launching";
  }
  return "done";
}

/** Thinking from nestedWorkerFollow — not ordinary model reasoning. */
export function parseNestedWorkerThinking(
  content: string,
  inProgress: boolean,
): NestedWorkerView | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const composer = trimmed.match(COMPOSER_HEADER);
  if (composer) {
    const body = trimmed.slice(composer[0].length);
    return {
      kind: "composer",
      title: "Composer 2.5",
      identity: composer[1],
      status: normalizeStatus(undefined, inProgress, body.trim().length > 0),
      lastLine: lastNonEmptyLine(body),
    };
  }

  const broker = trimmed.match(BROKER_HEADER);
  if (broker) {
    const body = trimmed.slice(broker[0].length);
    const statusMatches = [...trimmed.matchAll(BROKER_STATUS_LINE)];
    const latestStatus = statusMatches.at(-1)?.[1] ?? broker[3];
    return {
      kind: "broker",
      title: "Broker",
      identity: `${broker[1]}/${broker[2]}`,
      status: normalizeStatus(latestStatus, inProgress, body.trim().length > 0),
      lastLine:
        lastNonEmptyLine(body) ||
        (latestStatus ? `status: ${latestStatus}` : ""),
    };
  }

  const log = trimmed.match(LOG_HEADER);
  if (log) {
    const body = trimmed.slice(log[0].length);
    return {
      kind: "log",
      title: "Nested worker",
      identity: log[1],
      status: normalizeStatus(undefined, inProgress, body.trim().length > 0),
      lastLine: lastNonEmptyLine(body),
    };
  }

  return null;
}

const STATUS_LABEL: Record<NestedWorkerStatus, string> = {
  launching: "launching",
  running: "running",
  done: "done",
  failed: "failed",
};

export function NestedWorkerCard({ view }: { view: NestedWorkerView }) {
  const live = view.status === "launching" || view.status === "running";
  const tone =
    view.status === "failed"
      ? "text-error"
      : live
        ? "text-warning"
        : "text-description-muted";

  return (
    <div
      className="text-description-muted mt-1 flex min-w-0 flex-col gap-0.5 px-4 text-xs"
      data-testid="nested-worker-card"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {live ? (
          <CukiiThinkingGlyph />
        ) : (
          <span className={tone}>{view.status === "failed" ? "✖" : "○"}</span>
        )}
        <span className={tone}>
          {view.title} · {STATUS_LABEL[view.status]}
        </span>
        <span className="truncate" title={view.identity}>
          · {view.identity}
        </span>
      </div>
      {view.lastLine && (
        <div className="ml-5 truncate" title={view.lastLine}>
          {view.lastLine}
        </div>
      )}
    </div>
  );
}

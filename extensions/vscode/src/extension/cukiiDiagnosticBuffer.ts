import { maskCukiiReportText } from "core/cukiiReportMasking";

// One extension host serves every open Cukii window at once, so the ring has to
// hold enough lines that a busy neighbour cannot push a quiet session's own
// history out before that session files a report.
const MAX_LINES = 500;
const MAX_LINE_CHARS = 2_000;

/**
 * Per-tool-call chatter. One busy turn emits hundreds of these while the events
 * that explain a hang — spawn, failure, termination — appear once each, so an
 * unweighted tail is all noise and no cause.
 */
const HIGH_FREQUENCY_EVENT = /^bridge\.tool\./;

type DiagnosticLine = {
  /** Undefined for host-level events that belong to no single conversation. */
  sessionId?: string;
  event: string;
  text: string;
};

const lines: DiagnosticLine[] = [];

/**
 * Small process-local lifecycle ring used by issue reports. It deliberately
 * records no prompts, file contents or bearer material; any error text still
 * crosses the shared Portal 5 sanitizer before entering the ring.
 *
 * The owning conversation is taken from `details.sessionId` so that callers
 * keep one call shape and reports can be scoped without a second parameter to
 * thread through every bridge callback.
 */
export function recordCukiiDiagnostic(
  event: string,
  details?: Record<string, unknown>,
): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  const sessionId =
    typeof details?.sessionId === "string" && details.sessionId
      ? details.sessionId
      : undefined;
  lines.push({
    ...(sessionId ? { sessionId } : {}),
    event,
    text: maskCukiiReportText(
      `${new Date().toISOString()} ${event}${suffix}`,
    ).slice(0, MAX_LINE_CHARS),
  });
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

/**
 * Lines for one report. A report names exactly one session, so returning the
 * whole process ring both leaked a neighbouring conversation's lifecycle into
 * someone else's bug card and crowded out the session actually being reported.
 * Host-level lines carry no session and stay in every report.
 */
export function recentCukiiDiagnostics(
  limit = 80,
  sessionId?: string,
): string[] {
  const cap = Math.max(0, limit);
  const scoped =
    sessionId === undefined
      ? lines
      : lines.filter(
          (line) =>
            line.sessionId === undefined || line.sessionId === sessionId,
        );
  if (scoped.length <= cap) return scoped.map((line) => line.text);

  // Reserve the budget for the rare events first, then backfill with the newest
  // tool chatter. A plain tail of a busy turn contained nothing but tool
  // start/finish pairs, so a report about a freeze carried no spawn, failure or
  // termination line at all.
  const keep = new Set<DiagnosticLine>(
    scoped.filter((line) => !HIGH_FREQUENCY_EVENT.test(line.event)).slice(-cap),
  );
  for (let index = scoped.length - 1; index >= 0 && keep.size < cap; index--) {
    keep.add(scoped[index]);
  }
  // Filtering the source keeps the surviving lines in chronological order.
  return scoped.filter((line) => keep.has(line)).map((line) => line.text);
}

export function clearCukiiDiagnosticsForTest(): void {
  lines.length = 0;
}

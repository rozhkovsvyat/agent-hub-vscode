import { maskCukiiReportText } from "core/cukiiReportMasking";

const MAX_LINES = 200;
const lines: string[] = [];

/**
 * Small process-local lifecycle ring used by issue reports. It deliberately
 * records no prompts, file contents or bearer material; any error text still
 * crosses the shared Portal 5 sanitizer before entering the ring.
 */
export function recordCukiiDiagnostic(
  event: string,
  details?: Record<string, unknown>,
): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  lines.push(
    maskCukiiReportText(`${new Date().toISOString()} ${event}${suffix}`),
  );
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

export function recentCukiiDiagnostics(limit = 80): string[] {
  return lines.slice(-Math.max(0, limit));
}

export function clearCukiiDiagnosticsForTest(): void {
  lines.length = 0;
}

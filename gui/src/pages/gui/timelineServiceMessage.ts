/** Vendor status lines that belong on the timeline rail, not as a chat bubble. */
const SERVICE_MESSAGE =
  /^(?:Background agent\b.+|Subagent\b.+|Agent ".+")\s+(?:completed|finished|exited)\.?$/i;

export function isTimelineServiceMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes("\n")) return false;
  return SERVICE_MESSAGE.test(trimmed);
}

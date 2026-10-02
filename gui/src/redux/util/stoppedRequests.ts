import type { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";

const RECENT_USER_TURNS = 10;
const MAX_REQUESTS = 3;
const MAX_CHARS = 140;

function userText(item: ChatHistoryItemWithMessageId): string {
  const content = item.message.content;
  const text = Array.isArray(content)
    ? content.map((part) => (part.type === "text" ? part.text : "")).join(" ")
    : String(content ?? "");
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_CHARS ? `${flat.slice(0, MAX_CHARS - 1)}…` : flat;
}

/**
 * User requests whose turn the user stopped, among the recent user turns,
 * newest last. The bridge names them on every turn so a vendor that keeps a
 * stopped turn's background tasks "pending" (Kimi) does not restart them
 * later (card e423407d). Derived from persisted history, so it survives a
 * reload; the newest user message is the one being sent and is skipped.
 */
export function stoppedRequestTexts(
  history: readonly ChatHistoryItemWithMessageId[],
): string[] {
  const userIdx: number[] = [];
  history.forEach((item, i) => {
    if (item.message.role === "user" && !item.isSteer) userIdx.push(i);
  });
  const recent = userIdx.slice(-RECENT_USER_TURNS - 1, -1);
  const stopped: string[] = [];
  for (const start of recent) {
    const next = userIdx.find((i) => i > start) ?? history.length;
    const turn = history.slice(start + 1, next);
    const wasStopped = turn.some(
      (item) =>
        item.interrupted === true ||
        (item.toolCallStates ?? []).some((tool) => tool.status === "canceled"),
    );
    if (wasStopped) {
      const text = userText(history[start]);
      if (text) stopped.push(text);
    }
  }
  return stopped.slice(-MAX_REQUESTS);
}

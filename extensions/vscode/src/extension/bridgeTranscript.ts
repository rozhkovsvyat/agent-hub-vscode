import { ChatMessage, MessageContent } from "core";

/**
 * Keep native broker requests bounded.  The full chat is replayed by every
 * stateless CLI turn, so an unbounded transcript eventually dominates TTFT.
 */
export const MAX_BRIDGE_TRANSCRIPT_CHARS = 120_000;

export function contentToText(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => (part.type === "text" ? part.text : "[image attached]"))
    .join("\n");
}

function render(message: ChatMessage): string {
  return `${message.role.toUpperCase()}:\n${contentToText(message.content)}`;
}

/**
 * Retain complete newest turns first. A single oversized latest turn is tail
 * trimmed as the only way to honour the hard bound; the marker makes that loss
 * explicit rather than presenting it as a full conversation.
 */
export function buildBridgeTranscript(messages: ChatMessage[]): string {
  const turns = messages
    .filter((message) => message.role !== "tool")
    .map(render);
  const full = turns.join("\n\n");
  if (full.length <= MAX_BRIDGE_TRANSCRIPT_CHARS) {
    return full;
  }

  const marker =
    "[Cukii transcript omitted to keep native bridge latency bounded.]";
  const currentTurnMarker = "\n[Current turn middle omitted.]\n";
  const retained: string[] = [];
  let used = marker.length + 2; // separator between marker and retained turns
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    const separator = retained.length ? 2 : 0;
    if (used + separator + turn.length > MAX_BRIDGE_TRANSCRIPT_CHARS) {
      if (!retained.length) {
        const available = MAX_BRIDGE_TRANSCRIPT_CHARS - used;
        const body = available - currentTurnMarker.length;
        if (body > 0) {
          const head = Math.ceil(body / 2);
          retained.unshift(
            turn.slice(0, head) +
              currentTurnMarker +
              turn.slice(-(body - head)),
          );
        } else {
          retained.unshift(turn.slice(0, available));
        }
      }
      break;
    }
    retained.unshift(turn);
    used += separator + turn.length;
  }
  return `${marker}\n\n${retained.join("\n\n")}`;
}

import { ChatMessage, MessageContent } from "core";

/**
 * Keep native broker requests bounded.  The full chat is replayed by every
 * stateless CLI turn, so an unbounded transcript eventually dominates TTFT.
 */
export const MAX_BRIDGE_TRANSCRIPT_CHARS = 120_000;

/**
 * Keep roughly the same conservative share of the selected model window
 * instead of forcing every vendor through the smallest 200K-model budget.
 * Characters are intentionally budgeted below tokens: code, JSON and
 * Cyrillic can approach one token per character. Unknown models retain the
 * proven 120K fallback.
 */
export function bridgeTranscriptCharLimit(model: string): number {
  if (/^(?:fable|opus|sonnet)-5|^kimi-k3$|^deepseek-v4-pro$/.test(model)) {
    return 600_000;
  }
  if (/^grok-4-|^cursor:grok-4\./.test(model)) {
    return 300_000;
  }
  if (/^codex-5-|^kimi-k2|^kimi-k3-256k$/.test(model)) {
    return 153_000;
  }
  return MAX_BRIDGE_TRANSCRIPT_CHARS;
}

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
export function buildBridgeTranscript(
  messages: ChatMessage[],
  maxChars = MAX_BRIDGE_TRANSCRIPT_CHARS,
): string {
  const turns = messages
    .filter((message) => message.role !== "tool")
    .map(render);
  const full = turns.join("\n\n");
  if (full.length <= maxChars) {
    return full;
  }

  const marker =
    "[Only older Cukii history was omitted to bound latency. The complete newest retained turns follow and are authoritative continuation context.]";
  const currentTurnMarker = "\n[Current turn middle omitted.]\n";
  const retained: string[] = [];
  let used = marker.length + 2; // separator between marker and retained turns
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    const separator = retained.length ? 2 : 0;
    if (used + separator + turn.length > maxChars) {
      if (!retained.length) {
        const available = maxChars - used;
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

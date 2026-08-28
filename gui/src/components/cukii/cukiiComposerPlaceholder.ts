export const CUKII_COMPOSER_EMPTY_MESSAGES = [
  "What shall we bake today?",
  "Bring the task — Cukii will handle the crumbs.",
  "Ready to make something worth shipping?",
  "What are we fixing first?",
  "Drop in the context. Let’s get cooking.",
] as const;

function composerEmptyMessage(sessionId?: string): string {
  if (!sessionId) return CUKII_COMPOSER_EMPTY_MESSAGES[0];

  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return CUKII_COMPOSER_EMPTY_MESSAGES[
    (hash >>> 0) % CUKII_COMPOSER_EMPTY_MESSAGES.length
  ];
}

export function cukiiComposerPlaceholder({
  isInEdit,
  isStreaming,
  isMainInput,
  historyLength,
  sessionId,
}: {
  isInEdit: boolean;
  isStreaming: boolean;
  isMainInput: boolean;
  historyLength: number;
  sessionId?: string;
}): string {
  if (isInEdit) {
    return "Edit selected code";
  }

  if (isStreaming && isMainInput) {
    return "Queue another message…";
  }

  if (historyLength > 0) {
    return "ctrl esc to focus or unfocus Cukii";
  }

  return composerEmptyMessage(sessionId);
}

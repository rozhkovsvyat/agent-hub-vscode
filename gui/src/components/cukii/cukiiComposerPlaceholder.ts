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
  hasActiveEditorSelection = false,
  isComposerFocused = false,
  isWebviewFocused = false,
}: {
  isInEdit: boolean;
  isStreaming: boolean;
  isMainInput: boolean;
  historyLength: number;
  sessionId?: string;
  hasActiveEditorSelection?: boolean;
  isComposerFocused?: boolean;
  isWebviewFocused?: boolean;
}): string {
  if (isInEdit) {
    return "Edit selected code";
  }

  if (isStreaming && isMainInput) {
    return "Queue another message…";
  }

  if (hasActiveEditorSelection && !isComposerFocused && !isWebviewFocused) {
    return "ctrl esc to attach selected text";
  }

  if (historyLength > 0) {
    return "ctrl esc to focus or unfocus Cukii";
  }

  // Cukii has no prompt-suggestion provider in the IDE protocol. The native
  // TipTap placeholder is only rendered for an empty composer, so do not
  // synthesize a suggestion until the host supplies one.
  return composerEmptyMessage(sessionId);
}

export type InterruptShortcutState = {
  isStreaming: boolean;
  isCancelling: boolean;
  hasPendingPermission: boolean;
};

export function shouldInterruptFromEscape(
  event: KeyboardEvent,
  state: InterruptShortcutState,
): boolean {
  return (
    event.key === "Escape" &&
    state.isStreaming &&
    !state.isCancelling &&
    !state.hasPendingPermission &&
    !event.repeat &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

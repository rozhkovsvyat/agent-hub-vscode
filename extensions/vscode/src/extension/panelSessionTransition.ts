export function isRealPanelSessionTransition(
  previousSessionId: string | undefined,
  nextSessionId: string,
): boolean {
  return previousSessionId !== undefined && previousSessionId !== nextSessionId;
}

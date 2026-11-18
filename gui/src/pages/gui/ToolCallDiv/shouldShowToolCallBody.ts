export function shouldShowToolCallBody(
  open: boolean,
  live: boolean,
  focusView: boolean,
): boolean {
  return open || (live && !focusView);
}

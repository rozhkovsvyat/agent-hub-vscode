/**
 * The model pill lives inside the wrapping left footer group. Measuring that
 * group's height to toggle a class which then changes the same group's wrap
 * produces an infinite layout oscillation at the threshold width.
 *
 * Enter and leave thresholds are separated so a class-induced 4–8px height
 * change cannot reverse the decision.
 */
export function modelPillNeedsOwnRow(
  currentlyOnOwnRow: boolean,
  primaryHeightPx: number,
): boolean {
  const enterAt = 34;
  const leaveAt = 22;
  return currentlyOnOwnRow
    ? primaryHeightPx > leaveAt
    : primaryHeightPx > enterAt;
}

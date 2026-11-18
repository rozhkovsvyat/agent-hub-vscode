/** Hysteresis so the composer footer does not oscillate at the wrap threshold. */
export function shouldPlaceModelPillOnOwnRow(
  actionHeightPx: number,
  currentlyWrapped: boolean,
): boolean {
  return currentlyWrapped ? actionHeightPx > 24 : actionHeightPx > 30;
}

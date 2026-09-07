/** Extra air between the final glyph and MAX's absolutely positioned meta. */
export const USER_META_INLINE_GAP_PX = 4;

export function userMetaWidth(bubble: HTMLElement): number {
  const footerOrMeta = bubble.querySelector<HTMLElement>(
    ".cukii-user-fold-footer, .cukii-user-metadata",
  );
  return footerOrMeta
    ? Math.ceil(footerOrMeta.getBoundingClientRect().width)
    : 0;
}

function innerWidth(element: HTMLElement): number {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const width = element.getBoundingClientRect().width;
  if (!style) return width;
  return (
    width -
    parseFloat(style.paddingLeft || "0") -
    parseFloat(style.paddingRight || "0") -
    parseFloat(style.borderLeftWidth || "0") -
    parseFloat(style.borderRightWidth || "0")
  );
}

/** Resolve how wide the shrink-to-fit user lane is allowed to grow. */
function userLaneWidth(bubble: HTMLElement): number {
  const lane = bubble.parentElement;
  const row = lane?.parentElement;
  if (!lane || !row) return bubble.getBoundingClientRect().width;
  const style = bubble.ownerDocument.defaultView?.getComputedStyle(lane);
  const current = lane.getBoundingClientRect().width;
  const declared = style?.maxWidth ?? "";
  if (declared.endsWith("%")) {
    const share = (innerWidth(row) * parseFloat(declared)) / 100;
    if (Number.isFinite(share)) return Math.max(current, share);
  }
  const pixels = parseFloat(declared);
  return Number.isFinite(pixels) ? Math.max(current, pixels) : current;
}

/**
 * MAX lets the time/checks ride the last paragraph line only when the measured
 * meta plus its 4px breathing room fit before the lane limit. A wrapped CSS
 * pseudo-element opens a full line box, so the false branch uses a compact
 * flow row instead of leaving a blank band below the text.
 */
export function userMetaFitsOnLastLine(
  bubble: HTMLElement,
  measuredMetaWidth = userMetaWidth(bubble),
): boolean {
  if (bubble.dataset.cukiiCollapsible === "true") return false;
  const prose = bubble.querySelector<HTMLElement>(".ProseMirror");
  const last = prose?.lastElementChild;
  if (!prose || !last || last.tagName !== "P" || measuredMetaWidth <= 0) {
    return false;
  }

  const range = bubble.ownerDocument.createRange();
  if (typeof range.getClientRects !== "function") return false;
  range.selectNodeContents(last);
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  if (!rects.length) return false;

  const lastLine = rects[rects.length - 1]!;
  const style = bubble.ownerDocument.defaultView?.getComputedStyle(bubble);
  if (!style) return false;
  const contentRight =
    bubble.getBoundingClientRect().left +
    userLaneWidth(bubble) -
    parseFloat(style.paddingRight || "0") -
    parseFloat(style.borderRightWidth || "0");
  return (
    contentRight - lastLine.right >= measuredMetaWidth + USER_META_INLINE_GAP_PX
  );
}

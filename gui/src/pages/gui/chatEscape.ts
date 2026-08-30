const ESCAPE_OWNING_OVERLAY_SELECTOR =
  '[role="menu"], [role="dialog"], [role="listbox"], .tippy-box';

export function hasVisibleEscapeOwningOverlay(doc: Document = document) {
  return [...doc.querySelectorAll<HTMLElement>(ESCAPE_OWNING_OVERLAY_SELECTOR)].some(
    (element) => {
      if (element.hidden || element.getAttribute("aria-hidden") === "true") {
        return false;
      }
      const style = doc.defaultView?.getComputedStyle(element);
      return style?.display !== "none" && style?.visibility !== "hidden";
    },
  );
}

export function dispatchResponseEscape(
  event: KeyboardEvent,
  isStreaming: boolean,
  dispatchCancelStream: () => void,
  doc: Document = document,
) {
  if (
    event.key !== "Escape" ||
    !isStreaming ||
    event.repeat ||
    event.isComposing ||
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey ||
    hasVisibleEscapeOwningOverlay(doc)
  ) {
    return false;
  }
  event.preventDefault();
  dispatchCancelStream();
  return true;
}

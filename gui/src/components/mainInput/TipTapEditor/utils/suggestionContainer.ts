export const CUKII_TIPPY_CONTAINER_SELECTOR = "[data-cukii-tippy-container]";

/**
 * Suggestions belong to the editor that opened them. Historical user bubbles
 * render read-only TipTap instances too, so a document-wide id lookup can
 * attach the active composer's menu to an off-screen historical editor.
 */
export function findSuggestionContainer(
  editorDom: HTMLElement,
): HTMLElement | null {
  return (
    editorDom
      .closest<HTMLElement>(".cukii-input-box")
      ?.querySelector<HTMLElement>(CUKII_TIPPY_CONTAINER_SELECTOR) ?? null
  );
}

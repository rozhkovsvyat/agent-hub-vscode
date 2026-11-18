import { type RefObject, useLayoutEffect } from "react";

export const CUKII_CANVAS_VARIABLE = "--cukii-canvas";

const TRANSPARENT = /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/i;

/**
 * Returns the colour that is actually painted behind `element`.
 *
 * A CSS token cannot answer this. Cukii repaints html/body/#root with its own
 * surface tone, but a styled-component between #root and the transcript
 * repaints the canvas from a VS Code token, and four transparent wrappers sit
 * in between — so `background-color: inherit` resolves to `transparent`, not
 * to the colour a user sees. Walking up to the first opaque ancestor is the
 * only answer that stays true when either side changes.
 */
export function resolvePaintedBackground(
  element: HTMLElement | null,
): string | undefined {
  let node: HTMLElement | null = element;
  while (node) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && !TRANSPARENT.test(color.trim())) return color;
    node = node.parentElement;
  }
  return undefined;
}

/**
 * Publishes that colour as `--cukii-canvas` so sticky masks and the composer
 * fade can never drift from the canvas again — including after a theme switch
 * or a panel-tone toggle, which both land as attribute/style mutations.
 */
export function useMeasuredCanvasBackground(
  ref: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const root = document.documentElement;

    const apply = () => {
      const color = resolvePaintedBackground(ref.current);
      if (color) root.style.setProperty(CUKII_CANVAS_VARIABLE, color);
      else root.style.removeProperty(CUKII_CANVAS_VARIABLE);
    };

    apply();

    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(apply);
    // VS Code writes theme variables onto <html style> and the theme kind onto
    // <body class>; Cukii writes its surface/tone onto <html>.
    observer.observe(root, {
      attributeFilter: ["class", "style"],
      attributes: true,
    });
    observer.observe(root, {
      attributeFilter: ["data-cukii-surface", "data-cukii-panel-tone"],
      attributes: true,
    });
    if (document.body) {
      observer.observe(document.body, {
        attributeFilter: ["class", "style"],
        attributes: true,
      });
    }
    return () => observer.disconnect();
  }, [ref]);
}

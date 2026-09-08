import { maskCukiiReportText } from "core/cukiiReportMasking";

export type CukiiChatSnapshot = {
  dataUrl: string;
  pngBase64: string;
  width: number;
  height: number;
  byteLength: number;
};

/**
 * Every property the clone needs to lay itself out identically inside an SVG
 * foreignObject, where no stylesheet is available.
 *
 * `position` without `top/right/bottom/left` was the bug behind unusable
 * reports: a positioned element kept `position` but lost its offsets, fell
 * back to its static position, and the composer was drawn over the top of the
 * transcript instead of at the bottom of the window.
 */
const STYLE_PROPERTIES = [
  "align-content",
  "align-items",
  "align-self",
  "background-color",
  "background-image",
  "bottom",
  "border-bottom-color",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-bottom-style",
  "border-bottom-width",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-style",
  "border-top-width",
  "box-shadow",
  "box-sizing",
  "clear",
  "color",
  "column-gap",
  "display",
  "float",
  "flex",
  "flex-basis",
  "flex-direction",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "gap",
  "grid-auto-flow",
  "grid-template-columns",
  "height",
  "justify-content",
  "left",
  "letter-spacing",
  "line-height",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "mask-image",
  "-webkit-mask-image",
  "max-width",
  "min-height",
  "min-width",
  "object-fit",
  "opacity",
  "order",
  "overflow",
  "overflow-wrap",
  "overflow-x",
  "overflow-y",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "position",
  "right",
  "row-gap",
  "text-align",
  "text-decoration",
  "text-indent",
  "text-overflow",
  "text-transform",
  "top",
  "transform",
  "transform-origin",
  "vertical-align",
  "visibility",
  "white-space",
  "width",
  "word-break",
  "z-index",
] as const;

function inlineComputedStyles(source: Element, clone: Element): void {
  if (source instanceof HTMLElement && clone instanceof HTMLElement) {
    const computed = getComputedStyle(source);
    for (const property of STYLE_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value) clone.style.setProperty(property, value);
    }
    if (
      source instanceof HTMLInputElement ||
      source instanceof HTMLTextAreaElement
    ) {
      clone.setAttribute("value", maskCukiiReportText(source.value));
    }
  }
  if (source instanceof SVGElement && clone instanceof SVGElement) {
    const computed = getComputedStyle(source);
    for (const property of ["color", "fill", "stroke", "width", "height"]) {
      const value = computed.getPropertyValue(property);
      if (value) clone.style.setProperty(property, value);
    }
  }
  const sourceChildren = [...source.children];
  const cloneChildren = [...clone.children];
  for (let index = 0; index < sourceChildren.length; index++) {
    if (cloneChildren[index]) {
      inlineComputedStyles(sourceChildren[index], cloneChildren[index]);
    }
  }
}

export function sanitizeCukiiSnapshotClone(root: HTMLElement): void {
  root
    .querySelectorAll(
      ".cukii-report-overlay,.cukii-command-menu,.cukii-model-picker-backdrop,[role='tooltip'],script,style,iframe,frame,object,embed,link,meta,base,source,track,audio,video,portal,svg image,svg use,svg foreignObject",
    )
    .forEach((element) => element.remove());

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) node.data = maskCukiiReportText(node.data);

  root.querySelectorAll<HTMLElement>("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name === "href" ||
        name === "src" ||
        name === "srcset" ||
        name === "poster" ||
        name === "action" ||
        name === "formaction" ||
        name === "srcdoc" ||
        name === "data" ||
        name === "xlink:href" ||
        name === "cite" ||
        name === "background" ||
        name === "manifest" ||
        name === "ping" ||
        name === "profile" ||
        name === "usemap" ||
        name === "longdesc" ||
        name === "lowsrc"
      ) {
        element.removeAttribute(attribute.name);
      } else if (
        name === "value" ||
        name === "placeholder" ||
        name === "title" ||
        name === "aria-label" ||
        name === "alt" ||
        name.startsWith("data-")
      ) {
        element.setAttribute(
          attribute.name,
          maskCukiiReportText(attribute.value),
        );
      }
    }
    for (let index = element.style.length - 1; index >= 0; index--) {
      const property = element.style.item(index);
      if (/url\s*\(/i.test(element.style.getPropertyValue(property))) {
        element.style.removeProperty(property);
      }
    }
  });

  root.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    const placeholder = document.createElement("div");
    placeholder.textContent = "[image omitted]";
    placeholder.setAttribute(
      "aria-label",
      "Image omitted from sanitized snapshot",
    );
    placeholder.style.cssText = [
      `width:${image.style.width || "100%"}`,
      `height:${image.style.height || "96px"}`,
      "min-height:48px",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "border:1px solid rgba(127,127,127,.35)",
      "border-radius:8px",
      "color:rgba(127,127,127,.9)",
      "font:12px sans-serif",
    ].join(";");
    image.replaceWith(placeholder);
  });
}

function preserveTranscriptScroll(
  sourceRoot: HTMLElement,
  cloneRoot: HTMLElement,
): void {
  const source = sourceRoot.querySelector<HTMLElement>(".cukii-transcript");
  const clone = cloneRoot.querySelector<HTMLElement>(".cukii-transcript");
  if (!source || !clone || source.scrollTop <= 0) return;
  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.width = "100%";
  wrapper.style.transform = `translateY(-${source.scrollTop}px)`;
  while (clone.firstChild) wrapper.appendChild(clone.firstChild);
  clone.appendChild(wrapper);
  clone.style.overflow = "hidden";
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read snapshot."));
    reader.readAsDataURL(blob);
  });
}

function svgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("Could not render the sanitized Cukii DOM."));
    // Chromium treats an SVG foreignObject loaded from a blob: URL as an
    // origin-opaque image and taints the canvas on drawImage(). A fully
    // self-contained data: image has no external fetches (the sanitizer has
    // already removed every URL) and remains exportable via canvas.toBlob().
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/**
 * Rebuilds only the Cukii webview DOM. External images and links are removed,
 * sensitive text is masked, and the report overlay itself is excluded before
 * the clone is serialized into an SVG foreignObject and rasterized to PNG.
 */
export async function captureCukiiChatSnapshot(): Promise<CukiiChatSnapshot> {
  const source = document.getElementById("root");
  if (!source) throw new Error("Cukii chat root is unavailable.");
  const rect = source.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    throw new Error("Cukii chat is not visible enough to capture.");
  }

  const clone = source.cloneNode(true) as HTMLElement;
  inlineComputedStyles(source, clone);
  preserveTranscriptScroll(source, clone);
  sanitizeCukiiSnapshotClone(clone);
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.overflow = "hidden";

  const cssWidth = Math.round(rect.width);
  const cssHeight = Math.round(rect.height);
  const scale = Math.min(1, 1200 / cssWidth, 1600 / cssHeight);
  const width = Math.max(1, Math.round(cssWidth * scale));
  const height = Math.max(1, Math.round(cssHeight * scale));
  const serialized = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${cssWidth} ${cssHeight}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
  const image = await svgImage(svg);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PNG rendering is unavailable.");
  const background =
    getComputedStyle(document.body).backgroundColor || "#1e1e1e";
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("Cukii produced an empty snapshot.");
  const dataUrl = await blobToDataUrl(blob);
  return {
    dataUrl,
    pngBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    width,
    height,
    byteLength: blob.size,
  };
}

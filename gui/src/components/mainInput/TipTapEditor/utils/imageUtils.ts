import { GROK_INLINE_ARGV_IMAGE_MAX_DATA_URL_CHARS } from "core/cukiiPermissionModes";

import { IIdeMessenger } from "../../../../context/IdeMessenger";

export { GROK_INLINE_ARGV_IMAGE_MAX_DATA_URL_CHARS };

const IMAGE_RESOLUTION = 1024;
const MAX_IMAGE_FILE_BYTES = 10_000_000;
// Grok's only current image-input channel is an inline JSON argument. Windows
// limits a child process command line to 32,767 characters, so that one
// carrier needs a deliberately smaller alternate copy. Other broker vendors
// receive the original data URL through stdin or a materialized file.
export const GROK_INLINE_ARGV_IMAGE_RESOLUTION = 384;
// Two screenshots at 384px JPEG still overflow argv if quality stays high.
// Cap the data-URL so two attachments plus the text block stay under 28 KB.

const SUPPORTED_ORIGINAL_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export function supportsOriginalImageMimeType(mimeType: string): boolean {
  return SUPPORTED_ORIGINAL_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

export function grokInlineArgvImageEncodePlan(
  startResolution = GROK_INLINE_ARGV_IMAGE_RESOLUTION,
  startQuality = 0.7,
): Array<{ resolution: number; quality: number }> {
  const plan: Array<{ resolution: number; quality: number }> = [];
  let resolution = startResolution;
  let quality = startQuality;
  for (;;) {
    plan.push({ resolution, quality });
    if (resolution === 32 && quality === 0.15) break;
    quality = Math.max(0.15, Number((quality - 0.08).toFixed(2)));
    resolution = Math.max(32, Math.floor(resolution * 0.75));
  }
  return plan;
}

function encodeJpegDataUrl(
  img: HTMLImageElement,
  resolution: number,
  quality: number,
): string | undefined {
  const scaleFactor = Math.min(
    1,
    resolution / img.width,
    resolution / img.height,
  );

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scaleFactor));
  canvas.height = Math.max(1, Math.round(img.height * scaleFactor));

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.error("Error getting image data url: 2d context not found");
    return;
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

export function getDataUrlForFile(
  file: File,
  img: HTMLImageElement,
  resolution = IMAGE_RESOLUTION,
  maxDataUrlChars?: number,
): string | undefined {
  if (!maxDataUrlChars) {
    return encodeJpegDataUrl(img, resolution, 0.7);
  }

  for (const step of grokInlineArgvImageEncodePlan(resolution)) {
    const candidate = encodeJpegDataUrl(img, step.resolution, step.quality);
    if (candidate && candidate.length <= maxDataUrlChars) {
      return candidate;
    }
  }
  // The limit is a transport invariant, not a preference. Returning the last
  // oversized attempt makes the call site believe argv is safe and merely
  // delays the failure until CreateProcess. Fail closed instead.
  return undefined;
}

function readAsDataUrl(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

/**
 * Exact attachment bytes shared by the preview and every out-of-band broker
 * carrier. The accepted file is already bounded to 10 MB, so replacing a
 * screenshot with a 1600px JPEG would only lose information the vendor channel
 * can carry.
 */
export async function getOriginalDataUrlForFile(
  file: File,
): Promise<string | undefined> {
  const original = await readAsDataUrl(file);
  if (!original?.startsWith("data:image/")) return undefined;
  // `image/jpg` is a common browser/file-picker alias, but Claude's native
  // image block accepts the canonical `image/jpeg`. Relabeling the data URL
  // changes no payload bytes.
  return file.type.toLowerCase() === "image/jpg"
    ? original.replace(/^data:image\/jpg(?=[;,])/i, "data:image/jpeg")
    : original;
}

export async function handleImageFile(
  ideMessenger: IIdeMessenger,
  file: File,
): Promise<[HTMLImageElement, string, string, string | undefined] | undefined> {
  // check image type and size
  if (
    supportsOriginalImageMimeType(file.type) &&
    file.size <= MAX_IMAGE_FILE_BYTES
  ) {
    // check dimensions
    let _URL = window.URL || window.webkitURL;
    let img = new window.Image();
    img.src = _URL.createObjectURL(file);

    return await new Promise((resolve) => {
      img.onload = function () {
        const dataUrl = getDataUrlForFile(file, img);
        const inlineArgvSrc = getDataUrlForFile(
          file,
          img,
          GROK_INLINE_ARGV_IMAGE_RESOLUTION,
          GROK_INLINE_ARGV_IMAGE_MAX_DATA_URL_CHARS,
        );
        if (!dataUrl) {
          resolve(undefined);
          return;
        }

        void getOriginalDataUrlForFile(file).then((originalSrc) => {
          if (!originalSrc) {
            ideMessenger.post("showToast", [
              "error",
              "The original image could not be read.",
            ]);
            resolve(undefined);
            return;
          }
          let image = new window.Image();
          image.src = dataUrl;
          image.onload = function () {
            resolve([image, dataUrl, originalSrc, inlineArgvSrc]);
          };
        });
      };
    });
  } else {
    ideMessenger.post("showToast", [
      "error",
      "Images need to be JPEG, PNG, GIF, or WebP and at most 10MB in size.",
    ]);
  }
}

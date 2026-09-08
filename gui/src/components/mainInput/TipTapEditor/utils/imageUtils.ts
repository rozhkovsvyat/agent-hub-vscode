import { IIdeMessenger } from "../../../../context/IdeMessenger";

const IMAGE_RESOLUTION = 1024;
// Grok's only current image-input channel is an inline JSON argument. Windows
// limits a child process command line to 32,767 characters, so Broker mode
// needs a deliberately smaller attachment before it crosses the bridge.
export const BROKER_IMAGE_RESOLUTION = 384;
// Two screenshots at 384px JPEG still overflow argv if quality stays high.
// Cap the data-URL so two attachments plus the text block stay under 28 KB.
export const BROKER_IMAGE_MAX_DATA_URL_CHARS = 10_000;

export function brokerImageEncodePlan(
  startResolution = BROKER_IMAGE_RESOLUTION,
  startQuality = 0.7,
): Array<{ resolution: number; quality: number }> {
  const plan: Array<{ resolution: number; quality: number }> = [];
  let resolution = startResolution;
  let quality = startQuality;
  for (let i = 0; i < 8; i++) {
    plan.push({ resolution, quality });
    quality = Math.max(0.35, quality - 0.1);
    resolution = Math.max(160, Math.floor(resolution * 0.8));
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

  let last: string | undefined;
  for (const step of brokerImageEncodePlan(resolution)) {
    last = encodeJpegDataUrl(img, step.resolution, step.quality);
    if (last && last.length <= maxDataUrlChars) {
      return last;
    }
  }
  return last;
}

/**
 * Largest attachment kept verbatim for on-screen preview. Broker transport
 * shrinks pictures to 384px so they survive a Windows argv limit; that copy is
 * unreadable when the user opens it, and it used to be the only copy we had.
 * The display copy therefore lives beside it and never crosses the bridge.
 */
export const DISPLAY_ORIGINAL_MAX_BYTES = 2_500_000;
const DISPLAY_FALLBACK_RESOLUTION = 1600;
const DISPLAY_FALLBACK_QUALITY = 0.82;

function readAsDataUrl(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

/**
 * The picture the preview shows: the untouched original when it is small
 * enough to keep in session history, otherwise a 1600px re-encode. Never the
 * transport copy.
 */
export async function getDisplayDataUrlForFile(
  file: File,
  img: HTMLImageElement,
): Promise<string | undefined> {
  if (file.size <= DISPLAY_ORIGINAL_MAX_BYTES) {
    const original = await readAsDataUrl(file);
    if (original?.startsWith("data:image/")) return original;
  }
  return encodeJpegDataUrl(
    img,
    DISPLAY_FALLBACK_RESOLUTION,
    DISPLAY_FALLBACK_QUALITY,
  );
}

export async function handleImageFile(
  ideMessenger: IIdeMessenger,
  file: File,
  resolution = IMAGE_RESOLUTION,
  maxDataUrlChars?: number,
): Promise<[HTMLImageElement, string, string | undefined] | undefined> {
  let filesize = file.size / 1024 / 1024; // filesize in MB
  // check image type and size
  if (
    [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/svg",
      "image/webp",
    ].includes(file.type) &&
    filesize < 10
  ) {
    // check dimensions
    let _URL = window.URL || window.webkitURL;
    let img = new window.Image();
    img.src = _URL.createObjectURL(file);

    return await new Promise((resolve) => {
      img.onload = function () {
        const dataUrl = getDataUrlForFile(
          file,
          img,
          resolution,
          maxDataUrlChars,
        );
        if (!dataUrl) {
          return;
        }

        void getDisplayDataUrlForFile(file, img).then((displayUrl) => {
          let image = new window.Image();
          image.src = dataUrl;
          image.onload = function () {
            resolve([image, dataUrl, displayUrl]);
          };
        });
      };
    });
  } else {
    ideMessenger.post("showToast", [
      "error",
      "Images need to be in jpg or png format and less than 10MB in size.",
    ]);
  }
}

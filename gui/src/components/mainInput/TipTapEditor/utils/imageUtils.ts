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

export async function handleImageFile(
  ideMessenger: IIdeMessenger,
  file: File,
  resolution = IMAGE_RESOLUTION,
  maxDataUrlChars?: number,
): Promise<[HTMLImageElement, string] | undefined> {
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

        let image = new window.Image();
        image.src = dataUrl;
        image.onload = function () {
          resolve([image, dataUrl]);
        };
      };
    });
  } else {
    ideMessenger.post("showToast", [
      "error",
      "Images need to be in jpg or png format and less than 10MB in size.",
    ]);
  }
}

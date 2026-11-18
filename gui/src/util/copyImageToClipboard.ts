async function imageBlob(source: string): Promise<Blob> {
  const response = await fetch(source);
  if (!response.ok) throw new Error("The image could not be read.");
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("The attachment is not an image.");
  }
  return blob;
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type.toLowerCase() === "image/png") return blob;
  if (typeof createImageBitmap !== "function") {
    throw new Error("This webview cannot copy this image format.");
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The image could not be converted.");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) =>
          png
            ? resolve(png)
            : reject(new Error("The image could not be converted.")),
        "image/png",
      );
    });
  } finally {
    bitmap.close();
  }
}

/** Copy the exact preview image to the operating-system clipboard. */
export async function copyImageToClipboard(source: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard access is unavailable in this webview.");
  }
  const sourceBlob = await imageBlob(source);
  const png = await toPng(sourceBlob);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

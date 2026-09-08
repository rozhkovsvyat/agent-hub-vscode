import { afterEach, describe, expect, it, vi } from "vitest";
import { GROK_INLINE_ARGV_IMAGE_MAX_DATA_URL_CHARS } from "core/cukiiPermissionModes";

import {
  GROK_INLINE_ARGV_IMAGE_RESOLUTION,
  getDataUrlForFile,
  getOriginalDataUrlForFile,
  grokInlineArgvImageEncodePlan,
  supportsOriginalImageMimeType,
} from "./imageUtils";

afterEach(() => vi.restoreAllMocks());

describe("grokInlineArgvImageEncodePlan", () => {
  it("starts at the Grok argv resolution and shrinks until 32px", () => {
    const plan = grokInlineArgvImageEncodePlan();
    expect(plan[0]).toEqual({
      resolution: GROK_INLINE_ARGV_IMAGE_RESOLUTION,
      quality: 0.7,
    });
    expect(plan.at(-1)?.resolution).toBe(32);
    expect(plan.at(-1)?.quality).toBe(0.15);
  });

  it("keeps the per-image data-URL cap small enough for two attachments", () => {
    expect(GROK_INLINE_ARGV_IMAGE_MAX_DATA_URL_CHARS * 2).toBeLessThan(28_000);
  });

  it("fails closed when every encoded candidate exceeds the argv cap", () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, "toDataURL").mockReturnValue(
      `data:image/jpeg;base64,${"A".repeat(10_001)}`,
    );
    vi.spyOn(document, "createElement").mockReturnValue(canvas);

    const result = getDataUrlForFile(
      new File([new Uint8Array([1])], "entropy.png", { type: "image/png" }),
      { width: 512, height: 512 } as HTMLImageElement,
      GROK_INLINE_ARGV_IMAGE_RESOLUTION,
      GROK_INLINE_ARGV_IMAGE_MAX_DATA_URL_CHARS,
    );

    expect(result).toBeUndefined();
    expect(canvas.toDataURL).toHaveBeenCalledTimes(
      grokInlineArgvImageEncodePlan().length,
    );
  });
});

describe("getOriginalDataUrlForFile", () => {
  it("keeps the original bytes above the former 2.5 MB preview cutoff", async () => {
    const bytes = new Uint8Array(2_500_001);
    bytes[0] = 0x89;
    bytes[bytes.length - 1] = 0x42;
    const file = new File([bytes], "full-size.png", { type: "image/png" });

    const dataUrl = await getOriginalDataUrlForFile(file);

    expect(dataUrl).toBeDefined();
    const payload = dataUrl!.slice(dataUrl!.indexOf(",") + 1);
    const decoded = Buffer.from(payload, "base64");
    expect(decoded.byteLength).toBe(bytes.byteLength);
    expect(decoded[0]).toBe(0x89);
    expect(decoded.at(-1)).toBe(0x42);
  });

  it("accepts only MIME labels supported by the native image carriers", () => {
    expect(supportsOriginalImageMimeType("image/jpeg")).toBe(true);
    expect(supportsOriginalImageMimeType("image/jpg")).toBe(true);
    expect(supportsOriginalImageMimeType("image/png")).toBe(true);
    expect(supportsOriginalImageMimeType("image/gif")).toBe(true);
    expect(supportsOriginalImageMimeType("image/webp")).toBe(true);
    expect(supportsOriginalImageMimeType("image/svg")).toBe(false);
    expect(supportsOriginalImageMimeType("image/svg+xml")).toBe(false);
  });

  it("normalizes image/jpg metadata without changing the original bytes", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const file = new File([bytes], "alias.jpg", { type: "image/jpg" });

    const dataUrl = await getOriginalDataUrlForFile(file);

    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(
      Buffer.from(dataUrl!.slice(dataUrl!.indexOf(",") + 1), "base64"),
    ).toEqual(Buffer.from(bytes));
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { copyImageToClipboard } from "./copyImageToClipboard";

const PNG = new Blob([new Uint8Array([137, 80, 78, 71])], {
  type: "image/png",
});

describe("copyImageToClipboard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes the original PNG as an image clipboard item", async () => {
    const write = vi.fn(async (_items: ClipboardItem[]) => undefined);
    class ClipboardItemMock {
      constructor(readonly types: Record<string, Blob>) {}
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => PNG })),
    );
    vi.stubGlobal("ClipboardItem", ClipboardItemMock);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });

    await copyImageToClipboard("data:image/png;base64,iVBORw==");

    expect(write).toHaveBeenCalledOnce();
    const items = write.mock.calls.at(0)?.[0];
    expect(items).toHaveLength(1);
    expect(
      (items?.[0] as unknown as ClipboardItemMock).types["image/png"],
    ).toBe(PNG);
  });

  it("fails visibly when the webview clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    vi.stubGlobal("ClipboardItem", undefined);

    await expect(
      copyImageToClipboard("data:image/png;base64,iVBORw=="),
    ).rejects.toThrow(/clipboard/i);
  });
});

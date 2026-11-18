import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CukiiImageLightbox } from "./CukiiImageLightbox";

describe("CukiiImageLightbox clipboard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("copies the original preview from both composer and sent-message callers", async () => {
    const write = vi.fn(async () => undefined);
    class ClipboardItemMock {
      constructor(readonly types: Record<string, Blob>) {}
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      })),
    );
    vi.stubGlobal("ClipboardItem", ClipboardItemMock);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });

    render(
      <CukiiImageLightbox
        name="original.png"
        onClose={vi.fn()}
        source="data:image/png;base64,b3JpZ2luYWw="
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy image" }));

    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("supports the standard Ctrl/Cmd+C gesture while preview is open", async () => {
    const write = vi.fn(async () => undefined);
    class ClipboardItemMock {
      constructor(readonly types: Record<string, Blob>) {}
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      })),
    );
    vi.stubGlobal("ClipboardItem", ClipboardItemMock);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    render(
      <CukiiImageLightbox
        name="message.png"
        onClose={vi.fn()}
        source="data:image/png;base64,bWVzc2FnZQ=="
      />,
    );

    fireEvent.keyDown(document, { key: "c", ctrlKey: true });

    await waitFor(() => expect(write).toHaveBeenCalledOnce());
  });
});

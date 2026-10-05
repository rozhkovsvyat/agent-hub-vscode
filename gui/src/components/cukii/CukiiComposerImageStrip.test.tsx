import type { Editor } from "@tiptap/core";
import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import { clearSubmittedMainComposer } from "../mainInput/TipTapEditor/utils/editorConfig";
import { CukiiComposerImageStrip } from "./CukiiComposerImageStrip";

/**
 * Mirrors TipTap 2.27 `dispatchTransaction`: every document change emits
 * `transaction`; `update` is skipped when the command did not ask for it.
 */
function composerWithImages(
  names = ["screenshot.png"],
  startWithImage = true,
): Editor {
  let hasImage = startWithImage;
  const listeners = new Map<string, Set<(event: any) => void>>();
  const emit = (event: string, payload?: unknown) =>
    listeners.get(event)?.forEach((listener) => listener(payload));
  const change = (emitUpdate?: boolean) => {
    emit("transaction", { transaction: { docChanged: true } });
    if (emitUpdate) emit("update");
  };
  const editor = {
    commands: {
      clearContent: vi.fn((emitUpdate?: boolean) => {
        hasImage = false;
        change(emitUpdate);
        return true;
      }),
      setContent: vi.fn((_content: unknown, emitUpdate?: boolean) => {
        hasImage = true;
        change(emitUpdate);
        return true;
      }),
    },
    on: vi.fn((event: string, listener: (event: any) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    }),
    off: vi.fn((event: string, listener: (event: any) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    state: {
      doc: {
        descendants: (visitor: (node: unknown, pos: number) => void) => {
          if (!hasImage) return;
          names.forEach((name, index) =>
            visitor(
              {
                attrs: {
                  alt: name,
                  originalSrc: `data:image/png;base64,b3JpZ2luYWw=${index}`,
                  src: `data:image/png;base64,c2VudA==${index}`,
                },
                type: { name: "image" },
              },
              index,
            ),
          );
        },
      },
    },
  };
  return editor as unknown as Editor;
}

describe("CukiiComposerImageStrip submit lifecycle", () => {
  it("shows a recalled picture at once after arrow-up history recall", () => {
    // Card 6f01bf1d: recall uses setContent without emitUpdate, so the strip,
    // listening to `update` only, showed the picture after the next key.
    const editor = composerWithImages(["recalled.png"], false);
    render(<CukiiComposerImageStrip editor={editor} />);
    expect(screen.queryByLabelText("Attached images")).toBeNull();

    act(() => {
      editor.commands.setContent("<p>previous message</p>", false);
    });

    expect(screen.getByLabelText("Attached images")).toBeInTheDocument();
  });

  it("removes sent image pills immediately, without waiting for a keystroke", () => {
    const editor = composerWithImages();
    render(<CukiiComposerImageStrip editor={editor} />);

    expect(screen.getByLabelText("Attached images")).toBeInTheDocument();

    act(() => clearSubmittedMainComposer(editor, true, false));

    expect(screen.queryByLabelText("Attached images")).not.toBeInTheDocument();
  });

  it("stays below composer overlays so a leftover pill cannot cover the menu (ID-199)", () => {
    const css = readFileSync(
      join(process.cwd(), "src", "index.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.cukii-composer-attachment-strip\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*0/s,
    );
    expect(css).toMatch(
      /\.cukii-main-input-shell:has\(\.cukii-command-menu\)[\s\S]*?\.cukii-composer-attachment-strip/s,
    );
  });

  it("keeps the first preview on the left and appends newer images to the right", () => {
    const editor = composerWithImages(["first.png", "second.png", "third.png"]);
    render(<CukiiComposerImageStrip editor={editor} />);

    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent?.trim()),
    ).toEqual(["first.png", "second.png", "third.png"]);
  });
});

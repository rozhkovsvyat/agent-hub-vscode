import type { Editor } from "@tiptap/core";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { clearSubmittedMainComposer } from "../mainInput/TipTapEditor/utils/editorConfig";
import { CukiiComposerImageStrip } from "./CukiiComposerImageStrip";

function composerWithOneImage(): Editor {
  let hasImage = true;
  const updateListeners = new Set<() => void>();
  const editor = {
    commands: {
      clearContent: vi.fn((emitUpdate?: boolean) => {
        hasImage = false;
        if (emitUpdate) {
          updateListeners.forEach((listener) => listener());
        }
        return true;
      }),
    },
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "update") updateListeners.add(listener);
    }),
    off: vi.fn((event: string, listener: () => void) => {
      if (event === "update") updateListeners.delete(listener);
    }),
    state: {
      doc: {
        descendants: (visitor: (node: unknown, pos: number) => void) => {
          if (!hasImage) return;
          visitor(
            {
              attrs: {
                alt: "screenshot.png",
                originalSrc: "data:image/png;base64,b3JpZ2luYWw=",
                src: "data:image/png;base64,c2VudA==",
              },
              type: { name: "image" },
            },
            0,
          );
        },
      },
    },
  };
  return editor as unknown as Editor;
}

describe("CukiiComposerImageStrip submit lifecycle", () => {
  it("removes sent image pills immediately, without waiting for a keystroke", () => {
    const editor = composerWithOneImage();
    render(<CukiiComposerImageStrip editor={editor} />);

    expect(screen.getByLabelText("Attached images")).toBeInTheDocument();

    act(() => clearSubmittedMainComposer(editor, true, false));

    expect(screen.queryByLabelText("Attached images")).not.toBeInTheDocument();
  });
});

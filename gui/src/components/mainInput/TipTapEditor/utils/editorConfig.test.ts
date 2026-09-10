import type { JSONContent } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";

import type { Editor } from "@tiptap/core";

import {
  clearSubmittedMainComposer,
  hasValidEditorContent,
} from "./editorConfig";

describe("hasValidEditorContent", () => {
  it("accepts a top-level attachment as an image-only submission", () => {
    const imageOnly: JSONContent = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "data:image/png;base64,aW1hZ2U=" },
        },
      ],
    };

    expect(hasValidEditorContent(imageOnly)).toBe(true);
  });

  it("still rejects an actually empty or whitespace-only editor", () => {
    expect(hasValidEditorContent({ type: "doc", content: [] })).toBe(false);
    expect(
      hasValidEditorContent({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "   " }] },
        ],
      }),
    ).toBe(false);
  });
});

describe("clearSubmittedMainComposer", () => {
  it("removes image nodes from the live composer after a normal submit", () => {
    const clearContent = vi.fn();
    const editor = { commands: { clearContent } } as unknown as Editor;

    clearSubmittedMainComposer(editor, true, false);

    expect(clearContent).toHaveBeenCalledOnce();
    expect(clearContent).toHaveBeenCalledWith(true);
  });

  it("preserves historical and edit-mode editor state", () => {
    const clearContent = vi.fn();
    const editor = { commands: { clearContent } } as unknown as Editor;

    clearSubmittedMainComposer(editor, false, false);
    clearSubmittedMainComposer(editor, true, true);

    expect(clearContent).not.toHaveBeenCalled();
  });
});

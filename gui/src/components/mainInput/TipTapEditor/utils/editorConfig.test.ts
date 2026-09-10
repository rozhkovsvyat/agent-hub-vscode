import type { JSONContent } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";

import type { Editor } from "@tiptap/core";

import {
  CUKII_EDITOR_IMMEDIATELY_RENDER,
  clearSubmittedMainComposer,
  hasValidEditorContent,
  shouldDeferEnterToSuggestion,
} from "./editorConfig";

it("defers TipTap view creation until after the React commit", () => {
  expect(CUKII_EDITOR_IMMEDIATELY_RENDER).toBe(false);
});

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

describe("plain Enter submission", () => {
  it("does not let a stale closed suggestion flag turn Enter into a newline", () => {
    const input = document.createElement("div");
    input.className = "cukii-input-box";
    const editorDom = document.createElement("div");
    input.append(editorDom);

    expect(shouldDeferEnterToSuggestion(true, editorDom)).toBe(false);
    expect(shouldDeferEnterToSuggestion(false, editorDom)).toBe(false);
  });

  it("still lets the visible suggestion list own Enter", () => {
    const input = document.createElement("div");
    input.className = "cukii-input-box";
    const editorDom = document.createElement("div");
    const popup = document.createElement("div");
    popup.setAttribute("data-cukii-suggestion-open", "true");
    input.append(editorDom, popup);

    expect(shouldDeferEnterToSuggestion(true, editorDom)).toBe(true);
  });
});

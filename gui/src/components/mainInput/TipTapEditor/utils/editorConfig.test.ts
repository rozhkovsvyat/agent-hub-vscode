import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { hasValidEditorContent } from "./editorConfig";

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

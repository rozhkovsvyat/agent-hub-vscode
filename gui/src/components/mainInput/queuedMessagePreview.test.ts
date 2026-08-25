import { describe, expect, it } from "vitest";
import { previewFromEditorJson } from "./queuedMessagePreview";

describe("previewFromEditorJson", () => {
  it("joins paragraph text and truncates", () => {
    const preview = previewFromEditorJson(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "hello from the queued follow-up that should be shortened",
              },
            ],
          },
        ],
      },
      20,
    );
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(20);
    expect(preview.startsWith("hello")).toBe(true);
  });

  it("includes mention labels", () => {
    expect(
      previewFromEditorJson({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { label: "README.md" } },
              { type: "text", text: " please" },
            ],
          },
        ],
      }),
    ).toBe("README.md please");
  });

  it("falls back for code/image-only content", () => {
    expect(
      previewFromEditorJson({
        type: "doc",
        content: [{ type: "code-block", attrs: { item: { name: "a.ts" } } }],
      }),
    ).toBe("Вложение");
  });

  it("falls back to Сообщение when empty", () => {
    expect(
      previewFromEditorJson({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "   " }] },
        ],
      }),
    ).toBe("Сообщение");
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GUI_SRC = join(__dirname, "..", "..");

const strip = readFileSync(
  join(__dirname, "CukiiUserAttachmentStrip.tsx"),
  "utf8",
);
const imageUtils = readFileSync(
  join(GUI_SRC, "components/mainInput/TipTapEditor/utils/imageUtils.ts"),
  "utf8",
);
const editorConfig = readFileSync(
  join(GUI_SRC, "components/mainInput/TipTapEditor/utils/editorConfig.ts"),
  "utf8",
);
const processEditorContent = readFileSync(
  join(
    GUI_SRC,
    "components/mainInput/TipTapEditor/utils/processEditorContent.ts",
  ),
  "utf8",
);
const resolveEditorContent = readFileSync(
  join(
    GUI_SRC,
    "components/mainInput/TipTapEditor/utils/resolveEditorContent.ts",
  ),
  "utf8",
);

describe("просмотр показывает оригинал, а не транспортную копию", () => {
  it("сохраняется отдельная полноразмерная копия", () => {
    expect(imageUtils).toContain("getOriginalDataUrlForFile");
    expect(imageUtils).not.toContain("DISPLAY_ORIGINAL_MAX_BYTES");
    expect(imageUtils).not.toContain("DISPLAY_FALLBACK_RESOLUTION");
  });

  it("узел картинки несёт originalSrc", () => {
    expect(editorConfig).toContain("originalSrc");
    // Данные, а не DOM-атрибут: иначе data-URL оригинала удвоится в разметке.
    expect(editorConfig).toContain("renderHTML: () => ({})");
  });

  it("и плашка, и лайтбокс берут previewSrc", () => {
    expect(strip).toContain("src={attachment.previewSrc}");
    expect(strip).toContain("source={preview.previewSrc}");
    expect(strip).not.toContain("src={attachment.src}");
    expect(strip).not.toContain("src={preview.src}");
  });

  it("новый broker turn несёт оригинал и отдельную argv-копию", () => {
    expect(processEditorContent).toContain("attrs?.originalSrc");
    expect(processEditorContent).toContain("attrs?.displaySrc");
    expect(processEditorContent).toContain("attrs?.inlineArgvSrc");
    expect(resolveEditorContent).toContain('session.mode === "broker"');
    expect(resolveEditorContent).toContain(
      "processEditorContent(editorState, brokerMode)",
    );
  });
});

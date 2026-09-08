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

describe("просмотр показывает оригинал, а не транспортную копию", () => {
  it("сохраняется отдельная полноразмерная копия", () => {
    expect(imageUtils).toContain("getDisplayDataUrlForFile");
    expect(imageUtils).toContain("DISPLAY_ORIGINAL_MAX_BYTES");
  });

  it("узел картинки несёт displaySrc", () => {
    expect(editorConfig).toContain("displaySrc");
    // Данные, а не DOM-атрибут: иначе data-URL оригинала удвоится в разметке.
    expect(editorConfig).toContain("renderHTML: () => ({})");
  });

  it("и плашка, и лайтбокс берут previewSrc", () => {
    expect(strip).toContain("src={attachment.previewSrc}");
    expect(strip).toContain("src={preview.previewSrc}");
    expect(strip).not.toContain("src={attachment.src}");
    expect(strip).not.toContain("src={preview.src}");
  });

  it("вендор по-прежнему получает транспортную копию", () => {
    // Полноразмерная копия не должна попасть в запрос к модели: 384px нужны
    // из-за предела argv, а не по прихоти.
    expect(processEditorContent).not.toContain("displaySrc");
  });
});

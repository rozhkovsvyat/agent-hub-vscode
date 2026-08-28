import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const mediaDir = join(__dirname, "..", "media");

function readMediaIcon(fileName: string): string {
  return readFileSync(join(mediaDir, fileName.replace("media/", "")), "utf8");
}

describe("cukii brand icons", () => {
  it("keeps the title icon at a 22px optical size", () => {
    const titleSvg = readMediaIcon("media/cukii-title.svg");
    expect(titleSvg).toContain('width="22"');
    expect(titleSvg).toContain('height="22"');
  });

  it("moves only the three activity/title chip cutouts by -0.6px on x", () => {
    const activitySvg = readMediaIcon("media/cukii-activity.svg");
    const titleSvg = readMediaIcon("media/cukii-title.svg");

    for (const svg of [activitySvg, titleSvg]) {
      expect(svg).toContain('cx="26.6" cy="28.8" r="3.75"');
      expect(svg).toContain('cx="39.9" cy="35" r="5.25"');
      expect(svg).toContain('cx="28.2" cy="40.6" r="4.1"');
      expect(svg).toContain('viewBox="5 5 54 54"');
    }
    expect(activitySvg).not.toContain('width="22"');
  });

  it("moves the color-mark chips by the same offset without changing their radii", () => {
    const markSvg = readMediaIcon("media/cukii-mark.svg");

    expect(markSvg).toContain('cx="21.4" cy="26" r="2.7"');
    expect(markSvg).toContain('cx="34.9" cy="40" r="3.2"');
    expect(markSvg).toContain('cx="22.4" cy="42.5" r="2.95"');
  });
});

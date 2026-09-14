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

  it("wears the cookie in the activity bar, not a stand-in codicon", () => {
    // 2.0.98 shipped `$(circle-large-filled)` because a URI icon cannot pass
    // the CSS-mask CORS check in a Remote-SSH window. The owner looked at the
    // resulting circle and called it broken: the window people actually use
    // here is local, where the mask is same-origin and the cookie renders.
    // media/README-activity-icon.md carries the whole analysis; this pins the
    // decision so it is not quietly reverted a third time.
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8"),
    ) as {
      contributes: {
        viewsContainers: { activitybar: { id: string; icon: string }[] };
        views: Record<string, { id: string; icon?: string }[]>;
      };
    };
    const container = manifest.contributes.viewsContainers.activitybar.find(
      (entry) => entry.id === "cukii",
    );
    expect(container?.icon).toBe("media/cukii-activity.svg");
    expect(manifest.contributes.views.cukii[0]?.icon).toBe(
      "media/cukii-activity.svg",
    );
    // A mask paints the alpha channel, so the shape has to be filled, and the
    // chip cutouts have to come from the mask rather than from a background.
    const activitySvg = readMediaIcon("media/cukii-activity.svg");
    expect(activitySvg).toContain('fill="currentColor"');
    expect(activitySvg).toContain('mask="url(#cutout-mask)"');
  });

  it("cuts the Marketplace tile from the activity cookie, not the older mark", () => {
    // 2.0.126 shipped a store tile rendered from media/cukii-mark.svg — the
    // older, heavily outlined cookie — so the listing and the sidebar showed
    // two different biscuits. The tile must reuse the activity geometry.
    const activitySvg = readMediaIcon("media/cukii-activity.svg");
    const storeSvg = readMediaIcon("media/cukii-store.svg");

    const silhouette = (svg: string) => /\sd="(M56\.3[^"]+)"/.exec(svg)?.[1];
    expect(silhouette(storeSvg)).toBeDefined();
    expect(silhouette(storeSvg)).toBe(silhouette(activitySvg));

    for (const bite of [
      'cx="49.5" cy="14" r="10"',
      'cx="38.5" cy="8.5" r="6"',
    ]) {
      expect(storeSvg).toContain(bite);
      expect(activitySvg).toContain(bite);
    }
    for (const chip of [
      'cx="26.6" cy="28.8" r="3.75"',
      'cx="39.9" cy="35" r="5.25"',
      'cx="28.2" cy="40.6" r="4.1"',
    ]) {
      expect(storeSvg).toContain(chip);
    }

    // The tile is the only place the palette lives; the activity icon stays
    // monochrome because VS Code paints it through a CSS mask.
    expect(storeSvg).toContain('fill="#E3A867"');
    expect(activitySvg).toContain('fill="currentColor"');

    const generator = readFileSync(
      join(__dirname, "..", "scripts", "build-marketplace-icon.js"),
      "utf8",
    );
    expect(generator).toContain('"cukii-store.svg"');
    expect(generator).not.toContain('"cukii-mark.svg"');
  });

  it("moves the color-mark chips by the same offset without changing their radii", () => {
    const markSvg = readMediaIcon("media/cukii-mark.svg");

    expect(markSvg).toContain('cx="21.4" cy="26" r="2.7"');
    expect(markSvg).toContain('cx="34.9" cy="40" r="3.2"');
    expect(markSvg).toContain('cx="22.4" cy="42.5" r="2.95"');
  });
});

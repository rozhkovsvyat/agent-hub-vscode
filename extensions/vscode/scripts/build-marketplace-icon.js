// Renders media/icon.png (the Marketplace tile) from the current brand mark.
// The store icon used to be a stale Continue-era bitmap; regenerating it from
// media/cukii-mark.svg keeps the listing and the activity bar on one source.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const SIZE = Number(process.argv[2] || 512);
const mediaDir = path.join(__dirname, "..", "media");
const source = path.join(mediaDir, "cukii-mark.svg");
const target = path.join(mediaDir, "icon.png");

async function main() {
  const svg = fs.readFileSync(source);
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg.toString("utf8"));
  if (!viewBox) {
    throw new Error("cukii-mark.svg must declare a 0 0 N N viewBox");
  }
  const units = Number(viewBox[1]);
  if (units !== Number(viewBox[2])) {
    throw new Error("cukii-mark.svg viewBox must be square");
  }
  // librsvg rasterises at 72dpi unless told otherwise; density scales the
  // user units so the output lands on SIZE pixels without a resample blur.
  const density = Math.round((SIZE / units) * 72);

  const png = await sharp(svg, { density })
    .resize(SIZE, SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer();

  fs.writeFileSync(target, png);

  const meta = await sharp(png).metadata();
  const { data, info } = await sharp(png)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (y * info.width + x) * info.channels;
    return [
      data[i],
      data[i + 1],
      data[i + 2],
      info.channels > 3 ? data[i + 3] : 255,
    ];
  };
  const corner = px(0, 0);
  const centre = px(Math.floor(info.width / 2), Math.floor(info.height / 2));
  const opaque = corner[3] > 8;

  console.log(
    JSON.stringify(
      {
        target: path.relative(path.join(__dirname, ".."), target),
        bytes: png.length,
        width: meta.width,
        height: meta.height,
        format: meta.format,
        alpha: meta.hasAlpha,
        cornerRgba: corner,
        centreRgba: centre,
        cornerTransparent: !opaque,
      },
      null,
      1,
    ),
  );

  if (meta.width !== SIZE || meta.height !== SIZE) {
    throw new Error(
      `expected ${SIZE}x${SIZE}, got ${meta.width}x${meta.height}`,
    );
  }
  if (!meta.hasAlpha || opaque) {
    throw new Error("the rounded brand tile must keep transparent corners");
  }
  if (centre[3] < 200) {
    throw new Error("centre pixel is transparent: the mark did not rasterise");
  }
  console.log("MARKETPLACE-ICON-OK");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

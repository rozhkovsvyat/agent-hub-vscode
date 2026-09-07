import { afterEach, describe, expect, it } from "vitest";
import { userMetaFitsOnLastLine, userMetaWidth } from "./userMetaMode";

const realCreateRange = document.createRange.bind(document);

function rect(left: number, right: number, height = 19.5): DOMRect {
  return {
    left,
    right,
    top: 0,
    bottom: height,
    width: right - left,
    height,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function build(options: {
  lastLineRight: number;
  metaWidth?: number;
  tail?: string;
  empty?: boolean;
}) {
  const row = document.createElement("div");
  row.getBoundingClientRect = () => rect(0, 600);
  const lane = document.createElement("div");
  lane.style.maxWidth = "70%";
  lane.getBoundingClientRect = () => rect(0, 300);
  const bubble = document.createElement("div");
  bubble.className = "cukii-user-message-bubble";
  bubble.style.paddingRight = "10px";
  bubble.getBoundingClientRect = () => rect(0, 300);
  const prose = document.createElement("div");
  prose.className = "ProseMirror";
  const tail = document.createElement(options.tail ?? "p");
  if (!options.empty) tail.textContent = "message";
  prose.append(tail);
  const meta = document.createElement("span");
  meta.className = "cukii-user-metadata";
  meta.getBoundingClientRect = () => rect(0, options.metaWidth ?? 44, 14);
  bubble.append(prose, meta);
  lane.append(bubble);
  row.append(lane);
  document.body.append(row);

  document.createRange = () => {
    const range = realCreateRange();
    range.selectNodeContents = () => undefined;
    const list = options.empty ? [] : [rect(0, options.lastLineRight)];
    range.getClientRects = () =>
      ({
        length: list.length,
        item: (index: number) => list[index] ?? null,
        [Symbol.iterator]: () => list[Symbol.iterator](),
      }) as unknown as DOMRectList;
    return range;
  };
  return bubble;
}

afterEach(() => {
  document.createRange = realCreateRange;
  document.body.innerHTML = "";
});

describe("userMetaFitsOnLastLine", () => {
  it("measures the complete time/check strip", () => {
    expect(userMetaWidth(build({ lastLineRight: 100, metaWidth: 44.1 }))).toBe(
      45,
    );
  });

  it("lets a shrink-to-fit short bubble grow within its 70% lane", () => {
    // Lane limit 420, bubble content edge 410; 44px meta + 4px gap fits.
    expect(userMetaFitsOnLastLine(build({ lastLineRight: 350 }))).toBe(true);
  });

  it("uses the compact own row when a CSS spacer would wrap", () => {
    expect(userMetaFitsOnLastLine(build({ lastLineRight: 365 }))).toBe(false);
  });

  it("refuses image/code tails and empty paragraphs", () => {
    expect(
      userMetaFitsOnLastLine(build({ lastLineRight: 100, tail: "img" })),
    ).toBe(false);
    expect(
      userMetaFitsOnLastLine(build({ lastLineRight: 100, tail: "pre" })),
    ).toBe(false);
    expect(
      userMetaFitsOnLastLine(build({ lastLineRight: 100, empty: true })),
    ).toBe(false);
  });

  it("keeps a collapsed prompt footer on its own row", () => {
    const bubble = build({ lastLineRight: 100 });
    bubble.dataset.cukiiCollapsible = "true";
    expect(userMetaFitsOnLastLine(bubble)).toBe(false);
  });

  it("lets an expanded fold footer share the last text line when it fits", () => {
    const bubble = build({ lastLineRight: 345 });
    bubble.dataset.cukiiCollapsible = "true";
    bubble.classList.add("cukii-user-bubble--expanded");
    const metadata = bubble.querySelector(".cukii-user-metadata")!;
    const footer = document.createElement("span");
    footer.className = "cukii-user-fold-footer";
    footer.getBoundingClientRect = () => rect(0, 58, 14);
    metadata.replaceWith(footer);

    expect(userMetaWidth(bubble)).toBe(58);
    expect(userMetaFitsOnLastLine(bubble)).toBe(true);
  });

  it("NEGATIVE CONTROL: a wider receipt changes the fit decision", () => {
    expect(
      userMetaFitsOnLastLine(build({ lastLineRight: 350, metaWidth: 70 })),
    ).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { assistantMetaFitsOnLastLine } from "./StepContainer";

/**
 * The reply time rides the answer's last line only when it actually fits there.
 * Everything else — a code block, a table, a list, a heading, a streaming
 * indicator between the prose and the time — falls back to the compact own row,
 * where a collision with the glyphs is impossible.
 *
 * jsdom has no layout, so the geometry is injected: `getClientRects` for the
 * tail's text and `getBoundingClientRect` for the capsule and the clock. That is
 * the whole input the decision reads, which is what makes it testable at all —
 * the live DOM probe cannot reach it, because a cloned capsule keeps the class
 * React had already put on the original.
 */

const realCreateRange = document.createRange.bind(document);
afterEach(() => {
  document.createRange = realCreateRange;
  document.body.innerHTML = "";
});

function rect(left: number, right: number): DOMRect {
  return {
    left,
    right,
    top: 0,
    bottom: 19.5,
    width: right - left,
    height: 19.5,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function build(options: {
  /** Tag of the answer's last block. */
  tail: string;
  /** Right edge of the last text line inside that block. */
  lastLineRight: number;
  /** Rendered width of the <time> element. */
  timeWidth: number;
  /** An element between the prose and the time (the streaming indicator). */
  interloper?: boolean;
  /** No text at all in the tail block. */
  empty?: boolean;
  /** Right edge of the capsule itself. Defaults to the full lane. */
  bubbleRight?: number;
  /** `max-width` on the capsule, as Blink reports it back. */
  maxWidth?: string;
  /** Width of the row the capsule sits in, for a percentage max-width. */
  rowWidth?: number;
}) {
  const row = document.createElement("div");
  row.style.padding = "0px";
  row.getBoundingClientRect = () => rect(0, options.rowWidth ?? 400);

  const bubble = document.createElement("div");
  bubble.className = "cukii-assistant-bubble";
  // The capsule spans 0..400; the measured right inset is 10px of padding.
  bubble.style.paddingRight = "10px";
  if (options.maxWidth) bubble.style.maxWidth = options.maxWidth;
  bubble.getBoundingClientRect = () => rect(0, options.bubbleRight ?? 400);

  const prose = document.createElement("div");
  prose.className = "cukii-assistant-prose";
  const tail = document.createElement(options.tail);
  if (!options.empty) tail.textContent = "answer";
  prose.appendChild(tail);
  bubble.appendChild(prose);

  if (options.interloper) {
    bubble.appendChild(document.createElement("div"));
  }

  const meta = document.createElement("span");
  meta.className = "cukii-assistant-metadata";
  const time = document.createElement("time");
  time.textContent = "21:45";
  time.getBoundingClientRect = () => rect(0, options.timeWidth);
  meta.appendChild(time);
  bubble.appendChild(meta);

  document.createRange = () => {
    const range = realCreateRange();
    range.selectNodeContents = () => undefined;
    const rects = options.empty ? [] : [rect(0, options.lastLineRight)];
    range.getClientRects = () =>
      ({
        length: rects.length,
        item: (i: number) => rects[i] ?? null,
        [Symbol.iterator]: () => rects[Symbol.iterator](),
      }) as unknown as DOMRectList;
    return range;
  };

  row.appendChild(bubble);
  document.body.appendChild(row);
  return bubble;
}

describe("assistantMetaFitsOnLastLine", () => {
  it("rides the last line when the clock still fits after it", () => {
    // Content edge 400 - 10 = 390; the line ends at 300, the clock needs 26 + 5.
    const bubble = build({ tail: "p", lastLineRight: 300, timeWidth: 26 });
    expect(assistantMetaFitsOnLastLine(bubble)).toBe(true);
  });

  it("drops to its own row when the last line reaches the edge", () => {
    // 🔴 The owner's complaint. Forcing the inline reserve here would wrap it
    // onto a fresh 19.5px line box — that oversized band is what he saw.
    const bubble = build({ tail: "p", lastLineRight: 380, timeWidth: 26 });
    expect(assistantMetaFitsOnLastLine(bubble)).toBe(false);
  });

  it("refuses every tail that cannot host the clock on a text line", () => {
    // Same generous geometry as the passing case — only the tag differs, so a
    // false here is the tag's doing and nothing else. Three reviewers predicted
    // exactly this defect: an absolute clock landing on code or table glyphs.
    for (const tail of [
      "pre",
      "table",
      "ul",
      "ol",
      "h3",
      "blockquote",
      "div",
    ]) {
      const bubble = build({ tail, lastLineRight: 100, timeWidth: 26 });
      expect(
        assistantMetaFitsOnLastLine(bubble),
        `${tail} must not host the reply time`,
      ).toBe(false);
    }
  });

  it("refuses when something stands between the answer and the clock", () => {
    // While streaming, the thinking indicator sits there, so the clock is not
    // the tail of the answer at all and the reserve would be measured blind.
    const bubble = build({
      tail: "p",
      lastLineRight: 100,
      timeWidth: 26,
      interloper: true,
    });
    expect(assistantMetaFitsOnLastLine(bubble)).toBe(false);
  });

  it("refuses an empty tail rather than guessing", () => {
    const bubble = build({
      tail: "p",
      lastLineRight: 100,
      timeWidth: 26,
      empty: true,
    });
    expect(assistantMetaFitsOnLastLine(bubble)).toBe(false);
  });

  it("lets a short answer keep the clock on its line, capsule grows to fit", () => {
    // 🔴 The capsule is `width: fit-content`. A short answer's box ends ON its
    // last glyph, so measuring the space left inside the CURRENT box always
    // gives zero and every short answer — the commonest case — would be pushed
    // to its own row while the user capsule keeps the clock on the line. The
    // question is whether it fits once the capsule may grow to its max-width.
    // Capsule hugs at 0..300 (content edge 290, exactly where the text ends),
    // max-width 70% of a 600px row = 420, so the real content edge is 410.
    const bubble = build({
      tail: "p",
      lastLineRight: 290,
      timeWidth: 26,
      bubbleRight: 300,
      maxWidth: "70%",
      rowWidth: 600,
    });
    expect(assistantMetaFitsOnLastLine(bubble)).toBe(true);
  });

  it("still refuses when even the grown capsule has no room", () => {
    // The counterpart of the case above: growing is bounded by max-width, so a
    // line that runs to the limit gets the own row however the box is sized.
    const bubble = build({
      tail: "p",
      lastLineRight: 405,
      timeWidth: 26,
      bubbleRight: 415,
      maxWidth: "70%",
      rowWidth: 600,
    });
    expect(assistantMetaFitsOnLastLine(bubble)).toBe(false);
  });

  it("honours an explicit reserve over the measured one", () => {
    // The caller measures the reserve once and passes it in, so the value that
    // decides the mode and the value written into --cukii-meta-reserve are the
    // same number. A rounded reserve compared against an unrounded width let
    // the spacer wrap on a capsule the measurement had called inline.
    const bubble = build({ tail: "p", lastLineRight: 360, timeWidth: 26 });
    expect(assistantMetaFitsOnLastLine(bubble, 30)).toBe(true);
    expect(assistantMetaFitsOnLastLine(bubble, 31)).toBe(false);
  });

  it("NEGATIVE CONTROL: a wider clock takes its own row, it does not overlap", () => {
    // The reserve used to be a hard-coded 31px. With the same last line, a clock
    // that renders wider than the space left must fall to its own row — if the
    // width were ignored, both of these would answer the same way.
    const narrow = build({ tail: "p", lastLineRight: 350, timeWidth: 26 });
    expect(assistantMetaFitsOnLastLine(narrow)).toBe(true);
    const wide = build({ tail: "p", lastLineRight: 350, timeWidth: 60 });
    expect(assistantMetaFitsOnLastLine(wide)).toBe(false);
  });
});

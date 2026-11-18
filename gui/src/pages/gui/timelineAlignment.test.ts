import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("Cukii timeline content axis", () => {
  it("keeps prose, tool cards, Thought and Interrupted on one tokenized axis", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    // A direct child is the unit shared by prose, a tool card, Thought and
    // Interrupted. Its only horizontal axis is the item's common token.
    expect(css).toContain("--cukii-timeline-content-inset: 26px;");
    expect(css).toContain(
      "padding-inline-start: var(--cukii-timeline-content-inset);",
    );
    expect(css).toMatch(
      /\.cukii-timeline-item > \*\s*\{\s*margin-inline-start: 0;/,
    );
    expect(css).not.toContain("margin-left: 12px;");
  });

  it("keeps command cards responsive with long paths in both expansion states", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    expect(css).toContain(".cukii-command-card {");
    expect(css).toContain("min-width: 0;");
    expect(css).toContain("overflow: hidden;");
    expect(css).toContain(".cukii-command-code {");
    expect(css).toContain("overflow-wrap: anywhere;");
    expect(css).toContain("overflow-x: auto;");
  });
});

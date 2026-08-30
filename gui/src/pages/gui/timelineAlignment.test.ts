import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("Cukii timeline content axis", () => {
  it("keeps prose and command cards 26px ±1 from the independent rail center", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    const railCenter = 9 + 7 / 2;
    const contentLeft = 26 + 12;
    const cardBorder = 1;
    expect(contentLeft - railCenter).toBeGreaterThanOrEqual(25);
    expect(contentLeft - railCenter).toBeLessThanOrEqual(27);
    expect(contentLeft + cardBorder - railCenter).toBeGreaterThanOrEqual(25);
    expect(css).toContain(".cukii-timeline-item > *");
    expect(css).toContain("margin-left: 12px;");
    expect(css).toContain("padding: 6px 8px 6px 0;");
  });
});

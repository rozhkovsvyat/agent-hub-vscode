import { describe, expect, it } from "vitest";

import { modelPillNeedsOwnRow } from "./modelPillLayout";

describe("modelPillNeedsOwnRow", () => {
  it("enters the dedicated row only after the left group actually wraps", () => {
    expect(modelPillNeedsOwnRow(false, 18)).toBe(false);
    expect(modelPillNeedsOwnRow(false, 30)).toBe(false);
    expect(modelPillNeedsOwnRow(false, 36)).toBe(true);
  });

  it("does not leave the row when the class trims a few pixels of height", () => {
    expect(modelPillNeedsOwnRow(true, 36)).toBe(true);
    expect(modelPillNeedsOwnRow(true, 28)).toBe(true);
    expect(modelPillNeedsOwnRow(true, 23)).toBe(true);
  });

  it("leaves only when the left group is a single 18px row again", () => {
    expect(modelPillNeedsOwnRow(true, 18)).toBe(false);
  });

  it("NEGATIVE CONTROL: a 36↔28 oscillation must stay wrapped, not flip", () => {
    let onRow = false;
    for (const height of [36, 28, 36, 28, 36, 28]) {
      onRow = modelPillNeedsOwnRow(onRow, height);
    }
    expect(onRow).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { shouldPlaceModelPillOnOwnRow } from "./composerFooterLayout";

describe("shouldPlaceModelPillOnOwnRow", () => {
  it("uses hysteresis so a narrow composer does not jump (ID-264)", () => {
    expect(shouldPlaceModelPillOnOwnRow(31, false)).toBe(true);
    expect(shouldPlaceModelPillOnOwnRow(28, true)).toBe(true);
    expect(shouldPlaceModelPillOnOwnRow(24, true)).toBe(false);
    expect(shouldPlaceModelPillOnOwnRow(29, false)).toBe(false);
  });
});

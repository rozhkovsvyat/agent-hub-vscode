import { describe, expect, it } from "vitest";
import { shouldShowToolCallBody } from "./shouldShowToolCallBody";

describe("shouldShowToolCallBody", () => {
  it("auto-opens live tool calls when focus view is off", () => {
    expect(shouldShowToolCallBody(false, true, false)).toBe(true);
  });

  it("keeps live tool calls collapsed when focus view is on", () => {
    expect(shouldShowToolCallBody(false, true, true)).toBe(false);
  });

  it("still expands when the user opens a row", () => {
    expect(shouldShowToolCallBody(true, true, true)).toBe(true);
  });
});

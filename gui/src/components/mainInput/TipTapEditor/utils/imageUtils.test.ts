import { describe, expect, it } from "vitest";

import {
  BROKER_IMAGE_MAX_DATA_URL_CHARS,
  BROKER_IMAGE_RESOLUTION,
  brokerImageEncodePlan,
} from "./imageUtils";

describe("brokerImageEncodePlan", () => {
  it("starts at the broker resolution and shrinks until 160px", () => {
    const plan = brokerImageEncodePlan();
    expect(plan[0]).toEqual({
      resolution: BROKER_IMAGE_RESOLUTION,
      quality: 0.7,
    });
    expect(plan.at(-1)?.resolution).toBe(160);
    expect(plan.every((step) => step.quality >= 0.35)).toBe(true);
  });

  it("keeps the per-image data-URL cap small enough for two attachments", () => {
    expect(BROKER_IMAGE_MAX_DATA_URL_CHARS * 2).toBeLessThan(28_000);
  });
});

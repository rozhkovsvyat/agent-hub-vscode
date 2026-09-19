import { afterEach, describe, expect, it } from "vitest";

import {
  forgetVendorSession,
  isVendorSessionId,
  rememberVendorSession,
  rememberedVendorSession,
  resetVendorSessionsForTests,
} from "./bridgeVendorSession";

afterEach(() => {
  resetVendorSessionsForTests();
});

describe("bridgeVendorSession", () => {
  it("remembers a native id per Cukii session and model", () => {
    rememberVendorSession(
      "cukii-1",
      "fable-5-1",
      "9252c6e5-aaaa-bbbb-cccc-ddddeeeeffff",
    );
    expect(rememberedVendorSession("cukii-1", "fable-5-1")).toBe(
      "9252c6e5-aaaa-bbbb-cccc-ddddeeeeffff",
    );
    expect(rememberedVendorSession("cukii-1", "opus-5")).toBeUndefined();
    expect(rememberedVendorSession("cukii-2", "fable-5-1")).toBeUndefined();
  });

  it("rejects ids that cannot be passed as --resume argv", () => {
    rememberVendorSession("cukii-1", "fable-5-1", "short");
    rememberVendorSession("cukii-1", "fable-5-1", "bad id with spaces");
    rememberVendorSession("cukii-1", "fable-5-1", "");
    expect(rememberedVendorSession("cukii-1", "fable-5-1")).toBeUndefined();
    expect(isVendorSessionId("9252c6e5")).toBe(true);
  });

  it("forgets a stored id so the next turn is a cold start", () => {
    rememberVendorSession("cukii-1", "fable-5-1", "9252c6e5");
    forgetVendorSession("cukii-1", "fable-5-1");
    expect(rememberedVendorSession("cukii-1", "fable-5-1")).toBeUndefined();
  });
});

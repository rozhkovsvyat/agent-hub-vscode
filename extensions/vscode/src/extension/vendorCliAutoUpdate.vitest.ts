import { describe, expect, it } from "vitest";

import {
  VENDOR_CLI_UPDATE_FAILURE_INTERVAL_MS,
  VENDOR_CLI_UPDATE_SUCCESS_INTERVAL_MS,
  vendorCliUpdateIsDue,
} from "./vendorCliAutoUpdate";

describe("vendor CLI auto-update cadence", () => {
  it("checks an installed Cukii-owned CLI immediately, then daily after success", () => {
    const now = 2_000_000_000_000;
    expect(vendorCliUpdateIsDue(undefined, now)).toBe(true);
    expect(
      vendorCliUpdateIsDue(
        { attemptedAt: now, succeededAt: now },
        now + VENDOR_CLI_UPDATE_SUCCESS_INTERVAL_MS - 1,
      ),
    ).toBe(false);
    expect(
      vendorCliUpdateIsDue(
        { attemptedAt: now, succeededAt: now },
        now + VENDOR_CLI_UPDATE_SUCCESS_INTERVAL_MS,
      ),
    ).toBe(true);
  });

  it("backs off a failed update for an hour without postponing it for a day", () => {
    const now = 2_000_000_000_000;
    expect(
      vendorCliUpdateIsDue(
        { attemptedAt: now },
        now + VENDOR_CLI_UPDATE_FAILURE_INTERVAL_MS - 1,
      ),
    ).toBe(false);
    expect(
      vendorCliUpdateIsDue(
        { attemptedAt: now },
        now + VENDOR_CLI_UPDATE_FAILURE_INTERVAL_MS,
      ),
    ).toBe(true);
  });

  it("uses the last attempt for cadence even if success was recorded later", () => {
    const now = 2_000_000_000_000;
    expect(
      vendorCliUpdateIsDue(
        { attemptedAt: now, succeededAt: now + 500 },
        now + VENDOR_CLI_UPDATE_SUCCESS_INTERVAL_MS - 1,
      ),
    ).toBe(false);
  });
});

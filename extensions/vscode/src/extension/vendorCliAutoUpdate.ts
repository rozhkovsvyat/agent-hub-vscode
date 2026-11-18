import type { CukiiManagedAutoUpdateVendor } from "@cukii/vendor-bridge";

export const VENDOR_CLI_UPDATE_STATE_KEY = "cukii.vendorCliAutoUpdate.v1";
export const VENDOR_CLI_UPDATE_SUCCESS_INTERVAL_MS = 24 * 60 * 60_000;
export const VENDOR_CLI_UPDATE_FAILURE_INTERVAL_MS = 60 * 60_000;
export const VENDOR_CLI_UPDATE_IDLE_RETRY_MS = 60_000;
export const VENDOR_CLI_UPDATE_START_DELAY_MS = 5_000;
export const VENDOR_CLI_UPDATE_INSTALL_TIMEOUT_MS = 10 * 60_000;

export type VendorCliUpdateReceipt = {
  attemptedAt: number;
  succeededAt?: number;
};

export type VendorCliUpdateState = Partial<
  Record<CukiiManagedAutoUpdateVendor, VendorCliUpdateReceipt>
>;

export function vendorCliUpdateIsDue(
  previous: VendorCliUpdateReceipt | undefined,
  now: number,
): boolean {
  if (!previous) return true;
  const interval =
    previous.succeededAt !== undefined
      ? VENDOR_CLI_UPDATE_SUCCESS_INTERVAL_MS
      : VENDOR_CLI_UPDATE_FAILURE_INTERVAL_MS;
  return now - previous.attemptedAt >= interval;
}

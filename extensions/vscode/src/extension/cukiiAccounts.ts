// Everything the Accounts dialog shows: the model vendors from
// @cukii/vendor-bridge, then the non-vendor accounts that share the same row
// contract. Yougile stays in the plugin, so the combined listing lives here
// too. Kept separate from `listBrokerVendorAccounts`, which the model catalog
// reads — a testing account must never widen what the catalog considers a
// vendor.
import type { BrokerVendorAuthStatus } from "core/protocol/ideWebview";
import {
  listBrokerVendorAccounts,
  type ProtectedSecretStore,
} from "@cukii/vendor-bridge";
import { yougileAccountStatus } from "./yougileAccount";

export async function listCukiiAccounts(
  options: { store?: ProtectedSecretStore } = {},
): Promise<BrokerVendorAuthStatus[]> {
  const [vendors, yougile] = await Promise.all([
    listBrokerVendorAccounts(),
    yougileAccountStatus(options.store ? { store: options.store } : {}),
  ]);
  return [
    ...vendors.map((vendor) => ({ ...vendor, group: "vendor" as const })),
    yougile,
  ];
}

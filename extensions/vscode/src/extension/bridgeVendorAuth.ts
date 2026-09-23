// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  isMissingCliError,
  accountLabelFromAuthMetadata,
  storedCodexAccountLabel,
  classifyVendorAuthOutput,
  nativeCliCandidates,
  resolveNativeCli,
  bindUnixVendorAuthExecutable,
  probeSpec,
  launchKimiWeb,
  stopEphemeralKimiWeb,
  kimiCredentialFingerprint,
  logoutNativeKimiAccount,
  kimiDisplayIdentityFromUserInfo,
  localKimiServerIdentity,
  localKimiServerEmail,
  localKimiCredentials,
  managedKimiProfileIdentity,
  resolveKimiAccountIdentity,
  notInstalledVendorStatus,
  notSupportedVendorStatus,
  probeVendorExecutable,
  probeBrokerVendorAccount,
  watchVendorAuthTransition,
  vendorInstallTerminalOutcome,
  vendorAuthTransitionReached,
  extractAuthFlowAssist,
  clearBrokerVendorAccountCache,
  sortVendorAccountsByLabel,
  listBrokerVendorAccounts,
  vendorAuthTerminalCommand,
} from "@cukii/vendor-bridge";

// The Accounts dialog combines vendor rows with non-vendor accounts that share
// the row contract. Yougile stays in the plugin, so the combined listing stays
// here too. Kept separate from `listBrokerVendorAccounts`, which the model
// catalog reads — a testing account must never widen what the catalog
// considers a vendor.
import type { BrokerVendorAuthStatus } from "core/protocol/ideWebview";
import {
  listBrokerVendorAccounts as listVendorAccounts,
  type ProtectedSecretStore,
} from "@cukii/vendor-bridge";
import { yougileAccountStatus } from "./yougileAccount";

export async function listCukiiAccounts(
  options: { store?: ProtectedSecretStore } = {},
): Promise<BrokerVendorAuthStatus[]> {
  const [vendors, yougile] = await Promise.all([
    listVendorAccounts(),
    yougileAccountStatus(options.store ? { store: options.store } : {}),
  ]);
  return [
    ...vendors.map((vendor) => ({ ...vendor, group: "vendor" as const })),
    yougile,
  ];
}

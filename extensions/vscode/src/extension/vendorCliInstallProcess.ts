// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  vendorInstallProcessArgs,
  runVendorInstallProcess,
} from "@cukii/vendor-bridge";
export type {
  VendorInstallProcessResult,
} from "@cukii/vendor-bridge";

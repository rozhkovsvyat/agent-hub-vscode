// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  CUKII_UNIX_NPM_PREFIX_SEGMENTS,
  CUKII_UNIX_NODE_HOME_SEGMENTS,
  CUKII_UNIX_LIBEXEC_SEGMENTS,
  cukiiVendorPathSegments,
  vendorSpawnEnv,
  vendorInstallTerminalSpec,
} from "@cukii/vendor-bridge";
export type {
  VendorInstallTerminalSpec,
} from "@cukii/vendor-bridge";

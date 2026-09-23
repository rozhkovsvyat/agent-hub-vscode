// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  selfTestClaudePermissionWorker,
  probeCommandForRoute,
  resolveProbeCommand,
  probeCliRoute,
  clearPermissionCapabilityCacheForTests,
  cachedVendorPermissionCapabilities,
  cacheVendorPermissionCapabilitiesForTests,
  vendorPermissionCapabilities,
  allVendorPermissionCapabilities,
} from "@cukii/vendor-bridge";
// permissionCapabilities' own commandCandidates, disambiguated from the
// bridgeChatAdapter one inside the package index.
export { capabilityCommandCandidates as commandCandidates } from "@cukii/vendor-bridge";

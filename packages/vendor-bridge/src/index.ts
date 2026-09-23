export * from "./vendorBridgeHost";
export * from "./bridgeEvents";
export * from "./bridgeChildLifecycle";
export * from "./bridgeRunCoordinator";
export * from "./bridgeRunCancellation";
export * from "./bridgeDisposeTeardown";
export * from "./vendorCliCandidates";
export * from "./grokPrompt";
export * from "./bridgeImages";
export * from "./bridgeInbox";
export * from "./bridgeTranscript";
export * from "./vendorCliInstaller";
export * from "./vendorCliInstallProcess";
export * from "./bridgeStorageEnv";
export * from "./bridgeScratch";
export * from "./alibabaTokenPlan";
export * from "./bridgeVendorAuth";
export * from "./bridgeSilenceWatchdog";
export * from "./grokMcpPreflight";
export * from "./bridgeVendorSession";
export * from "./bridgeFactDiscipline";
export * from "./bridgeVendorMcp";
export * from "./bridgeRunBinding";
export * from "./nestedWorkerFollow";
export * from "./bridgeSteer";
export * from "./bridgeControls";
export * from "./bridgeModelCatalog";
export * from "./codexModelsCacheHeal";
export * from "./claudePermissionBroker";
export * from "./runtimeCanaryAttestation";
// commandCandidates also lives in bridgeChatAdapter with a different
// signature; permissionCapabilities is listed explicitly to keep the index
// unambiguous (see the aliases at the bottom).
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
} from "./permissionCapabilities";
export * from "./ownerFileTransaction";
export * from "./bridgeUiClient";
export * from "./claudePermissionJsonl";
export * from "./claudePermissionMcpWorker";
export * from "./bridgeChatAdapter";

// `commandCandidates` exists in both bridgeChatAdapter and permissionCapabilities
// with different signatures; a star-export conflict would silently drop it from
// the index, so both are also available under explicit aliases. The extension
// shims re-export each under its original name.
export { commandCandidates as bridgeRouteCommandCandidates } from "./bridgeChatAdapter";
export { commandCandidates as capabilityCommandCandidates } from "./permissionCapabilities";

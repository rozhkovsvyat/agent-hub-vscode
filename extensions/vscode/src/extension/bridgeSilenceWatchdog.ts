// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  BRIDGE_SILENCE_LIMITS,
  BRIDGE_VENDOR_STARTUP_LIMITS,
  VENDORS_REPORTING_TOOLS_AFTER_THE_FACT,
  reportsToolsAfterTheFact,
  bridgeSilenceLimits,
  bridgeStartupAdvice,
  BridgeSilenceWatchdog,
} from "@cukii/vendor-bridge";
export type {
  BridgeVendorAdvice,
  SilenceWatchdogLimits,
  SilenceWatchdogClock,
  SilenceVerdict,
} from "@cukii/vendor-bridge";

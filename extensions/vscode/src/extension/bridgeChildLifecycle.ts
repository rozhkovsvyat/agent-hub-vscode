// Extracted to packages/vendor-bridge (phase 1); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  terminateBridgeChild,
  tasklistProbeIndicatesAlive,
  isBridgePidAlive,
  isBridgeProcessTreeAlive,
  manualTreeKillCommand,
  retryBridgeTreeKill,
} from "@cukii/vendor-bridge";
export type {
  TerminationOptions,
  BridgeTreeKillRetryOptions,
} from "@cukii/vendor-bridge";

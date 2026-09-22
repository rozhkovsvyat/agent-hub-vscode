// Extracted to packages/vendor-bridge (phase 1); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export { BridgeRunCoordinator, bridgeRunAcceptsSteer } from "@cukii/vendor-bridge";
export type {
  BridgeRunIdentity,
  BridgeRunAcquireResult,
  BridgeRunCoordinatorOptions,
} from "@cukii/vendor-bridge";

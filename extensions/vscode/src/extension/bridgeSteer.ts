// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  BridgeSteeringController,
  shouldHoldBridgeTerminal,
} from "@cukii/vendor-bridge";
export type {
  SteerMessage,
  SteerWriter,
} from "@cukii/vendor-bridge";

// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  listBridgeScopes,
  openBridgeSession,
  recoverBridgeSession,
  listBrokerSessions,
  delegateBridgeWorker,
  pollWorkerStatus,
} from "@cukii/vendor-bridge";
export type {
  BridgeScope,
} from "@cukii/vendor-bridge";

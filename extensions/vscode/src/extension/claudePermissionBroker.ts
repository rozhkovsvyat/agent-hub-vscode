// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  permissionInputFingerprint,
  restrictPrivateDirectory,
  ClaudePermissionBroker,
} from "@cukii/vendor-bridge";
export type {
  ClaudePermissionDecision,
  ClaudePermissionRequest,
  ClaudePermissionBrokerOptions,
} from "@cukii/vendor-bridge";
